import { spawn } from "node:child_process";
import type {
  ExternalEventRecord,
  ExecutorReferences,
  ExternalExecutionStatus,
} from "../../../../domain/execution/run.js";
import type {
  RecoveryObservation,
  TaskExecution,
  TaskExecutor,
  TaskLaunch,
} from "../../../../ports/task-executor.js";
import { TaskExecutorError } from "../../../../ports/task-executor.js";
import {
  assertOrcaSuccess,
  decodeCheck,
  decodeDispatch,
  decodeDispatchShow,
  decodeOrcaProcessFailure,
  decodeRunCreate,
  decodeTaskCreate,
  decodeTerminalCreate,
  decodeTaskList,
  decodeWorkerShow,
  decodeWorkerRead,
  OrcaResponseError,
} from "./orca-response.js";
import {
  disabledDiagnostics,
  type DiagnosticContext,
  type DiagnosticSink,
} from "../../../../ports/diagnostics.js";

interface CommandResult {
  stdout: string;
  stderr: string;
  json: unknown;
}

export type OrcaStartupDelay = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

const STARTUP_DELAY_MS = 8_000;

const abortError = (signal?: AbortSignal): Error =>
  signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");

const defaultStartupDelay: OrcaStartupDelay = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

export class OrcaTaskExecutor implements TaskExecutor {
  private readonly transcriptStates = new Map<
    string,
    {
      cursor?: string | number;
      source?: "transcript" | "terminal";
      reading: boolean;
      disabled: boolean;
      warned: boolean;
      replay: boolean;
    }
  >();

  constructor(
    private readonly executable = process.env.ORCA_CLI_COMMAND || "orca",
    private readonly diagnostics: DiagnosticSink = disabledDiagnostics,
    private readonly startupDelay: OrcaStartupDelay = defaultStartupDelay,
  ) {}

  async recover(
    identity: string,
    references: ExecutorReferences | undefined,
    projectWorkspace: string,
    diagnosticContext?: DiagnosticContext,
  ): Promise<RecoveryObservation> {
    let taskId = references?.taskId;
    let lookupLogs = { stdout: "", stderr: "" };
    if (!taskId) {
      const listed = await this.run(
        ["orchestration", "task-list", "--json"],
        projectWorkspace,
      );
      lookupLogs = { stdout: listed.stdout, stderr: listed.stderr };
      const tasks = this.decode(listed, decodeTaskList, lookupLogs);
      taskId = tasks.find((task) => task.attemptIdentity === identity)?.taskId;
      if (!taskId) return { status: "not_found" };
    }
    const shown = await this.run(
      ["orchestration", "dispatch-show", "--task", taskId, "--json"],
      projectWorkspace,
    );
    const logs = {
      stdout: lookupLogs.stdout + shown.stdout,
      stderr: lookupLogs.stderr + shown.stderr,
    };
    const dispatch = this.decode(shown, decodeDispatchShow, logs);
    if (!dispatch)
      return {
        status: "start_unknown",
        references: {
          taskId,
          dispatchId: references?.dispatchId ?? `unknown:${identity}`,
          runId: references?.runId,
        },
        logs,
      };
    if (dispatch.taskId !== taskId)
      throw new TaskExecutorError(
        `Orca dispatch-show returned task ${dispatch.taskId} for requested task ${taskId}`,
        logs,
      );
    if (references?.dispatchId && references.dispatchId !== dispatch.dispatchId)
      throw new TaskExecutorError(
        `Orca dispatch-show returned dispatch ${dispatch.dispatchId} instead of persisted dispatch ${references.dispatchId}`,
        logs,
      );
    const dispatchId = references?.dispatchId ?? dispatch.dispatchId;
    const recoveredReferences: ExecutorReferences = {
      taskId,
      dispatchId,
      runId: references?.runId ?? dispatch.runId,
      terminalHandle: references?.terminalHandle ?? dispatch.terminalHandle,
    };
    await this.readTranscript(
      recoveredReferences,
      projectWorkspace,
      diagnosticContext,
    );
    const state = dispatch.workerState;
    if (state === "start_unknown" || state === "stop_unknown")
      return { status: state, references: recoveredReferences, logs };
    if (["succeeded", "stopped"].includes(state ?? ""))
      return {
        status: "completed",
        references: recoveredReferences,
        logs,
      };
    if (["failed", "abandoned"].includes(state ?? ""))
      return {
        status: "failed",
        references: recoveredReferences,
        logs,
      };
    if (["starting", "ready", "stopping"].includes(state ?? ""))
      return {
        status: "active",
        references: recoveredReferences,
        logs,
      };
    return {
      status: "start_unknown",
      references: recoveredReferences,
      logs,
    };
  }

  async execute(
    launch: TaskLaunch,
    onStarted: (references: ExecutorReferences) => Promise<void>,
    onEvent?: (event: ExternalEventRecord) => Promise<void>,
  ): Promise<TaskExecution> {
    const logs = { stdout: "", stderr: "" };
    const command = async (args: string[]): Promise<CommandResult> => {
      try {
        const result = await this.run(
          args,
          launch.projectWorkspace,
          launch.signal,
          launch.diagnosticContext,
        );
        logs.stdout += result.stdout;
        logs.stderr += result.stderr;
        return result;
      } catch (error) {
        if (error instanceof TaskExecutorError) {
          logs.stdout += error.logs.stdout;
          logs.stderr += error.logs.stderr;
          throw new TaskExecutorError(error.message, { ...logs });
        }
        throw error;
      }
    };
    const contract = JSON.stringify({
      happyMachineAttemptIdentity: launch.identity,
      projectWorkspace: launch.projectWorkspace,
      contextPath: launch.contextPath,
      outputDirectory: launch.outputDirectory,
      resultPath: launch.resultPath,
      instructions: launch.instructions,
      prompt: this.effectivePrompt(launch),
      model: launch.model,
      timeoutMs: launch.timeoutMs,
      attemptNumber: launch.attemptNumber,
    });
    const runReceipt = await command([
      "orchestration",
      "run-create",
      "--objective",
      `Happy Machine ${launch.identity}`,
      "--json",
    ]);
    const { runId: orcaRunId } = this.decode(runReceipt, decodeRunCreate, logs);
    const taskReceipt = await command([
      "orchestration",
      "task-create",
      "--spec",
      contract,
      "--json",
    ]);
    const { taskId } = this.decode(taskReceipt, decodeTaskCreate, logs);
    const terminalReceipt = await command([
      "terminal",
      "create",
      "--worktree",
      "current",
      "--command",
      this.codexCommand(launch.model),
      "--focus",
      "--json",
    ]);
    const { terminalHandle } = this.decode(
      terminalReceipt,
      decodeTerminalCreate,
      logs,
    );
    let dispatch!: { taskId: string; dispatchId: string; status: string };
    try {
      await this.startupDelay(STARTUP_DELAY_MS, launch.signal);
      const dispatchReceipt = await command([
        "orchestration",
        "dispatch",
        "--task",
        taskId,
        "--run",
        orcaRunId,
        "--to",
        terminalHandle,
        "--inject",
        "--json",
      ]);
      dispatch = this.decode(dispatchReceipt, decodeDispatch, logs);
      if (dispatch.taskId !== taskId)
        throw new TaskExecutorError(
          `Orca dispatch returned task ${dispatch.taskId} instead of created task ${taskId}`,
          { ...logs },
        );
      if (dispatch.status !== "dispatched")
        throw new TaskExecutorError(
          `Orca dispatch returned unexpected status ${dispatch.status}`,
          { ...logs },
        );
    } catch (error) {
      try {
        await this.run(
          ["terminal", "close", "--terminal", terminalHandle, "--json"],
          launch.projectWorkspace,
          undefined,
          launch.diagnosticContext,
        );
      } catch {
        // Preserve the launch failure; cleanup is best effort.
      }
      throw error;
    }
    const references: ExecutorReferences = {
      runId: orcaRunId,
      taskId,
      dispatchId: dispatch.dispatchId,
      terminalHandle,
    };
    await onStarted(references);
    let transcriptTimer: NodeJS.Timeout | undefined;
    if (this.diagnostics.enabled) {
      await this.readTranscript(
        references,
        launch.projectWorkspace,
        launch.diagnosticContext,
      );
      transcriptTimer = setInterval(() => {
        void this.readTranscript(
          references,
          launch.projectWorkspace,
          launch.diagnosticContext,
        );
      }, 1000);
      transcriptTimer.unref();
    }
    const observedEvents = new Map<string, ExternalEventRecord>();
    try {
      while (true) {
        const completion = await command([
          "orchestration",
          "check",
          "--wait",
          "--types",
          "worker_done,escalation,question",
          "--timeout-ms",
          String(launch.timeoutMs),
          "--json",
        ]);
        const observation = this.decode(
          completion,
          (value) => decodeCheck(value, references.dispatchId),
          logs,
        );
        for (const event of observation.events) {
          const previous = observedEvents.get(event.id);
          if (previous?.status === event.status) continue;
          observedEvents.set(event.id, event);
          await onEvent?.(event);
        }
        if (observation.completion?.outcome === "failed")
          throw new TaskExecutorError(
            `Orca worker ${references.dispatchId} reported failed completion`,
            { ...logs },
          );
        if (observation.completion?.outcome === "succeeded") break;
        if (!observation.events.length)
          throw new TaskExecutorError(
            "Orca check returned without completion or a structured intervention event",
            { ...logs },
          );
      }
    } finally {
      if (transcriptTimer) clearInterval(transcriptTimer);
      await this.drainTranscript(
        references,
        launch.projectWorkspace,
        launch.diagnosticContext,
      );
    }
    return { references, logs };
  }

  async cancel(
    references: ExecutorReferences,
    projectWorkspace: string,
    diagnosticContext?: DiagnosticContext,
  ): Promise<void> {
    await this.readTranscript(references, projectWorkspace, diagnosticContext);
    await this.run(
      [
        "orchestration",
        "worker-stop",
        "--dispatch",
        references.dispatchId,
        "--json",
      ],
      projectWorkspace,
      undefined,
      diagnosticContext,
    );
    await this.drainTranscript(references, projectWorkspace, diagnosticContext);
  }

  async reconcile(
    references: ExecutorReferences,
    projectWorkspace: string,
    diagnosticContext?: DiagnosticContext,
  ): Promise<ExternalExecutionStatus> {
    const result = await this.run(
      [
        "orchestration",
        "worker-show",
        "--dispatch",
        references.dispatchId,
        "--json",
      ],
      projectWorkspace,
      undefined,
      diagnosticContext,
    );
    const worker = this.decode(result, decodeWorkerShow);
    await this.readTranscript(references, projectWorkspace, diagnosticContext);
    if (worker.dispatchId !== references.dispatchId)
      throw new TaskExecutorError(
        `Orca worker-show returned dispatch ${worker.dispatchId} instead of persisted dispatch ${references.dispatchId}`,
        { stdout: result.stdout, stderr: result.stderr },
      );
    if (worker.taskId !== references.taskId)
      throw new TaskExecutorError(
        `Orca worker-show returned task ${worker.taskId} instead of persisted task ${references.taskId}`,
        { stdout: result.stdout, stderr: result.stderr },
      );
    const state = worker.workerState;
    if (["failed", "succeeded", "stopped", "abandoned"].includes(state ?? ""))
      return "stopped";
    if (["starting", "ready", "stopping"].includes(state ?? ""))
      return "active";
    return "unknown";
  }

  private run(
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    context?: DiagnosticContext,
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const operation = args[1] ?? args[0] ?? "command";
      const startedAt = Date.now();
      this.diagnostics.emit({
        kind: "orca",
        name: `${operation}_started`,
        context,
      });
      const child = spawn(this.executable, args, { cwd, env: process.env });
      const stopObserving = () => child.kill("SIGTERM");
      if (signal?.aborted) stopObserving();
      else signal?.addEventListener("abort", stopObserving, { once: true });
      let stdout = "";
      let stderr = "";
      let finished = false;
      const finish = (code: number | null) => {
        if (finished) return;
        finished = true;
        this.emitCommandFinished(
          operation,
          startedAt,
          code,
          stdout,
          stderr,
          context,
        );
      };
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on(
        "error",
        (error) => (
          finish(null),
          reject(
            new TaskExecutorError(
              `Orca ${operation} failed to start: ${error.message}`,
              { stdout, stderr },
            ),
          )
        ),
      );
      child.on("close", (code) => {
        finish(code);
        signal?.removeEventListener("abort", stopObserving);
        let json: unknown;
        try {
          json = JSON.parse(stdout) as unknown;
        } catch {
          if (code !== 0)
            return reject(
              new TaskExecutorError(
                this.processFailureMessage(operation, code, stdout, stderr),
                { stdout, stderr },
              ),
            );
          reject(
            new TaskExecutorError(`Orca ${operation} returned invalid JSON`, {
              stdout,
              stderr,
            }),
          );
          return;
        }
        if (code !== 0)
          return reject(
            new TaskExecutorError(
              this.processFailureMessage(operation, code, stdout, stderr, json),
              { stdout, stderr },
            ),
          );
        try {
          assertOrcaSuccess(json, operation);
        } catch (error) {
          if (error instanceof OrcaResponseError)
            return reject(
              new TaskExecutorError(error.message, { stdout, stderr }),
            );
          throw error;
        }
        resolve({ stdout, stderr, json });
      });
    });
  }

  private emitCommandFinished(
    operation: string,
    startedAt: number,
    exitCode: number | null,
    stdout: string,
    stderr: string,
    context?: DiagnosticContext,
  ): void {
    this.diagnostics.emit({
      kind: "orca",
      name: `${operation}_finished`,
      context,
      data: {
        durationMs: Date.now() - startedAt,
        exitCode,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
      },
    });
  }

  private async readTranscript(
    references: ExecutorReferences,
    cwd: string,
    context?: DiagnosticContext,
    signal?: AbortSignal,
  ): Promise<number> {
    if (!this.diagnostics.enabled) return 0;
    const state = this.transcriptStates.get(references.dispatchId) ?? {
      reading: false,
      disabled: false,
      warned: false,
      replay: this.diagnostics.replay,
    };
    this.transcriptStates.set(references.dispatchId, state);
    if (state.reading || state.disabled) return 0;
    state.reading = true;
    try {
      const args = [
        "orchestration",
        "worker-read",
        "--dispatch",
        references.dispatchId,
        "--source",
        "auto",
        "--limit",
        "200",
        ...(state.cursor === undefined
          ? []
          : ["--cursor", String(state.cursor)]),
        "--json",
      ];
      const result = await this.run(args, cwd, signal, {
        ...context,
        dispatchId: references.dispatchId,
      });
      const page = this.decode(result, decodeWorkerRead);
      if (state.source && state.source !== page.source) {
        this.diagnostics.emit({
          kind: "warning",
          name: "transcript_source_changed",
          context: { ...context, dispatchId: references.dispatchId },
          text: `from=${state.source} to=${page.source}; cursor reset`,
        });
        state.cursor = undefined;
        state.source = undefined;
        state.replay = true;
        return 200;
      }
      state.source = page.source;
      state.cursor = page.cursor;
      if (page.source === "terminal" && page.fallbackReason && !state.warned) {
        state.warned = true;
        this.diagnostics.emit({
          kind: "warning",
          name: "transcript_terminal_fallback",
          context: { ...context, dispatchId: references.dispatchId },
          source: "terminal",
          text: `reason=${page.fallbackReason}`,
        });
      }
      let emitted = 0;
      for (const line of page.terminalLines) {
        this.emitTranscript(
          line,
          page.source,
          state.replay,
          references,
          context,
        );
        emitted++;
      }
      for (const message of page.messages) {
        if (message.role === "user" || message.role === "system") continue;
        for (const block of message.blocks) {
          if (block.type === "image") continue;
          const text =
            block.type === "text"
              ? block.text
              : block.type === "tool-call"
                ? `[tool ${block.name}] ${this.safeJson(block.input)}`
                : `[tool result${block.isError ? " error" : ""}] ${block.output}`;
          for (const line of text.split(/\r?\n/)) {
            this.emitTranscript(
              line,
              page.source,
              state.replay,
              references,
              context,
            );
            emitted++;
          }
        }
      }
      if (emitted > 0) state.replay = false;
      return emitted;
    } catch (error) {
      if (signal?.aborted) return 200;
      const sourceChanged =
        error instanceof Error && error.message.includes("source_changed");
      if (sourceChanged) {
        state.cursor = undefined;
        state.source = undefined;
        state.replay = true;
        this.diagnostics.emit({
          kind: "warning",
          name: "transcript_source_changed",
          context: { ...context, dispatchId: references.dispatchId },
          text: "cursor reset",
        });
        return 200;
      }
      if (!state.warned) {
        state.warned = true;
        this.diagnostics.emit({
          kind: "warning",
          name: "transcript_disabled",
          context: { ...context, dispatchId: references.dispatchId },
          text: error instanceof Error ? error.message : String(error),
        });
      }
      state.disabled = true;
      return 0;
    } finally {
      state.reading = false;
    }
  }

  private async drainTranscript(
    references: ExecutorReferences,
    cwd: string,
    context?: DiagnosticContext,
  ): Promise<void> {
    if (!this.diagnostics.enabled) return;
    const deadline = Date.now() + 2000;
    let count = 200;
    while (Date.now() < deadline && count >= 200)
      count = await this.readTranscript(
        references,
        cwd,
        context,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      );
    if (count >= 200)
      this.diagnostics.emit({
        kind: "warning",
        name: "transcript_backlog_remaining",
        context: { ...context, dispatchId: references.dispatchId },
      });
  }

  private emitTranscript(
    text: string,
    source: "transcript" | "terminal",
    replay: boolean,
    references: ExecutorReferences,
    context?: DiagnosticContext,
  ): void {
    this.diagnostics.emit({
      kind: "transcript",
      name: "agent",
      context: { ...context, dispatchId: references.dispatchId },
      source,
      replay,
      text,
    });
  }

  private safeJson(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserializable input]";
    }
  }

  private effectivePrompt(launch: TaskLaunch): string {
    const outcomes = launch.allowedOutcomes
      .map((outcome) => `- ${JSON.stringify(outcome)}`)
      .join("\n");
    return `${launch.prompt}\n\n---\nHappy Machine result contract (required)\n\nWrite the task result to exactly: ${JSON.stringify(launch.resultPath)}\nThe assigned output directory is: ${JSON.stringify(launch.outputDirectory)}\n\nAllowed outcomes:\n${outcomes}\n\nThe result file must be valid JSON with this structure:\n{\n  "outcome": "<one allowed outcome>",\n  "documents": ["relative/path/to/document.md"],\n  "error": <optional serializable diagnostic data>\n}\n\nEvery declared document must be a Markdown file, and each document path must be relative to the assigned output directory. Only result.json controls the workflow transition; stdout and stderr do not.`;
  }

  private codexCommand(model: string): string {
    return `codex --model ${this.shellQuote(model)} --dangerously-bypass-approvals-and-sandbox`;
  }

  private shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
  }

  private decode<T>(
    result: CommandResult,
    decoder: (value: unknown) => T,
    logs: { stdout: string; stderr: string } = {
      stdout: result.stdout,
      stderr: result.stderr,
    },
  ): T {
    try {
      return decoder(result.json);
    } catch (error) {
      if (error instanceof OrcaResponseError)
        throw new TaskExecutorError(error.message, { ...logs });
      throw error;
    }
  }

  private processFailureMessage(
    operation: string,
    code: number | null,
    stdout: string,
    stderr: string,
    json?: unknown,
  ): string {
    const failure = decodeOrcaProcessFailure(json);
    const detail = failure
      ? `${failure.code ? `${failure.code}: ` : ""}${failure.message}`
      : stderr.trim() || stdout.trim();
    const exitCode = code === null ? "unknown" : String(code);
    return `Orca ${operation} failed (${exitCode})${detail ? `: ${detail}` : ""}`;
  }
}
