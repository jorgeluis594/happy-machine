import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type {
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
  decodeOrcaProcessFailure,
  decodeTerminalClose,
  decodeTerminalCreate,
  decodeTerminalRead,
  decodeTerminalSend,
  decodeTerminalShow,
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
const runtimeCommands = {
  codex: "codex",
  opencode: "opencode",
} as const satisfies Record<TaskLaunch["runtime"], string>;
const RESULT_POLL_MS = 250;

const abortError = (signal?: AbortSignal): Error =>
  signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");

const defaultDelay: OrcaStartupDelay = (milliseconds, signal) =>
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
      reading: boolean;
      disabled: boolean;
      warned: boolean;
      replay: boolean;
    }
  >();

  constructor(
    private readonly executable = process.env.ORCA_CLI_COMMAND || "orca",
    private readonly diagnostics: DiagnosticSink = disabledDiagnostics,
    private readonly startupDelay: OrcaStartupDelay = defaultDelay,
    private readonly pollDelay: OrcaStartupDelay = defaultDelay,
  ) {}

  async recover(
    _identity: string,
    references: ExecutorReferences | undefined,
    projectWorkspace: string,
    resultPath?: string,
    diagnosticContext?: DiagnosticContext,
  ): Promise<RecoveryObservation> {
    if (!references) return { status: "not_found" };
    if (resultPath && (await this.resultAvailable(resultPath)))
      return {
        status: "completed",
        references,
        logs: { stdout: "", stderr: "" },
      };
    const handle = this.terminalHandle(references);
    if (!handle)
      return {
        status: "start_unknown",
        references,
        logs: { stdout: "", stderr: "" },
      };
    const recoveredReferences = this.references(handle, references);
    try {
      const shown = await this.run(
        ["terminal", "show", "--terminal", handle, "--json"],
        projectWorkspace,
        undefined,
        diagnosticContext,
      );
      const terminal = this.decode(shown, decodeTerminalShow);
      this.assertHandle("show", terminal.terminalHandle, handle, shown);
      await this.readTranscript(
        recoveredReferences,
        projectWorkspace,
        diagnosticContext,
      );
      return {
        status: terminal.active ? "active" : "failed",
        references: recoveredReferences,
        logs: { stdout: shown.stdout, stderr: shown.stderr },
      };
    } catch (error) {
      if (this.staleTerminal(error)) {
        if (resultPath && (await this.resultAvailable(resultPath)))
          return {
            status: "completed",
            references: recoveredReferences,
            logs:
              error instanceof TaskExecutorError
                ? error.logs
                : { stdout: "", stderr: "" },
          };
        return {
          status: "failed",
          references: recoveredReferences,
          logs:
            error instanceof TaskExecutorError
              ? error.logs
              : { stdout: "", stderr: "" },
        };
      }
      throw error;
    }
  }

  async execute(
    launch: TaskLaunch,
    onStarted: (references: ExecutorReferences) => Promise<void>,
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

    const terminalReceipt = await command([
      "terminal",
      "create",
      "--worktree",
      "current",
      "--command",
      this.runtimeCommand(launch.runtime, launch.reasoning),
      "--focus",
      "--json",
    ]);
    const { terminalHandle } = this.decode(
      terminalReceipt,
      decodeTerminalCreate,
      logs,
    );
    const references = this.references(terminalHandle);
    let promptDelivered = false;
    try {
      await onStarted(references);
      await this.startupDelay(STARTUP_DELAY_MS, launch.signal);
      const sendReceipt = await command([
        "terminal",
        "send",
        "--terminal",
        terminalHandle,
        "--text",
        this.agentPrompt(launch),
        "--enter",
        "--json",
      ]);
      const sent = this.decode(sendReceipt, decodeTerminalSend, logs);
      this.assertHandle(
        "send",
        sent.terminalHandle,
        terminalHandle,
        sendReceipt,
      );
      if (!sent.accepted)
        throw new TaskExecutorError(
          `Orca send did not accept input for terminal ${terminalHandle}`,
          { ...logs },
        );
      promptDelivered = true;
      await this.waitForResult(
        launch.resultPath,
        references,
        launch.projectWorkspace,
        launch.signal,
        launch.diagnosticContext,
        logs,
      );
      await this.drainTranscript(
        references,
        launch.projectWorkspace,
        launch.diagnosticContext,
      );
      return { references, logs };
    } catch (error) {
      if (!promptDelivered)
        await this.closeBestEffort(
          terminalHandle,
          launch.projectWorkspace,
          launch.diagnosticContext,
        );
      throw error;
    }
  }

  async cancel(
    references: ExecutorReferences,
    projectWorkspace: string,
    diagnosticContext?: DiagnosticContext,
  ): Promise<void> {
    const handle = this.requireTerminalHandle(references);
    await this.readTranscript(references, projectWorkspace, diagnosticContext);
    const result = await this.run(
      ["terminal", "close", "--terminal", handle, "--tab", "--json"],
      projectWorkspace,
      undefined,
      diagnosticContext,
    );
    const closed = this.decode(result, decodeTerminalClose);
    this.assertHandle("close", closed.terminalHandle, handle, result);
    await this.drainTranscript(references, projectWorkspace, diagnosticContext);
  }

  async reconcile(
    references: ExecutorReferences,
    projectWorkspace: string,
    diagnosticContext?: DiagnosticContext,
  ): Promise<ExternalExecutionStatus> {
    const handle = this.requireTerminalHandle(references);
    try {
      const result = await this.run(
        ["terminal", "show", "--terminal", handle, "--json"],
        projectWorkspace,
        undefined,
        diagnosticContext,
      );
      const terminal = this.decode(result, decodeTerminalShow);
      this.assertHandle("show", terminal.terminalHandle, handle, result);
      await this.readTranscript(
        references,
        projectWorkspace,
        diagnosticContext,
      );
      return terminal.active ? "active" : "stopped";
    } catch (error) {
      if (this.staleTerminal(error)) return "stopped";
      throw error;
    }
  }

  private async waitForResult(
    resultPath: string,
    references: ExecutorReferences,
    cwd: string,
    signal: AbortSignal | undefined,
    context: DiagnosticContext | undefined,
    logs: { stdout: string; stderr: string },
  ): Promise<void> {
    const handle = this.requireTerminalHandle(references);
    while (!(await this.resultAvailable(resultPath))) {
      await this.readTranscript(references, cwd, context, signal);
      try {
        const result = await this.run(
          ["terminal", "show", "--terminal", handle, "--json"],
          cwd,
          signal,
          context,
        );
        logs.stdout += result.stdout;
        logs.stderr += result.stderr;
        const terminal = this.decode(result, decodeTerminalShow, logs);
        this.assertHandle("show", terminal.terminalHandle, handle, result);
        if (!terminal.active)
          throw new TaskExecutorError(
            `Orca terminal ${handle} stopped before producing result.json`,
            { ...logs },
          );
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        if (this.staleTerminal(error)) {
          if (await this.resultAvailable(resultPath)) return;
          throw new TaskExecutorError(
            `Orca terminal ${handle} disappeared before producing result.json`,
            { ...logs },
          );
        }
        if (error instanceof TaskExecutorError) throw error;
      }
      await this.pollDelay(RESULT_POLL_MS, signal);
    }
  }

  private async resultAvailable(resultPath: string): Promise<boolean> {
    try {
      return (await readFile(resultPath)).length > 0;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return false;
      throw error;
    }
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
      child.on("error", (error) => {
        finish(null);
        reject(
          new TaskExecutorError(
            `Orca ${operation} failed to start: ${error.message}`,
            { stdout, stderr },
          ),
        );
      });
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
    const handle = this.requireTerminalHandle(references);
    const state = this.transcriptStates.get(handle) ?? {
      reading: false,
      disabled: false,
      warned: false,
      replay: this.diagnostics.replay,
    };
    this.transcriptStates.set(handle, state);
    if (state.reading || state.disabled) return 0;
    state.reading = true;
    try {
      const result = await this.run(
        [
          "terminal",
          "read",
          "--terminal",
          handle,
          "--limit",
          "200",
          ...(state.cursor === undefined
            ? []
            : ["--cursor", String(state.cursor)]),
          "--json",
        ],
        cwd,
        signal,
        { ...context, executionId: handle },
      );
      const page = this.decode(result, decodeTerminalRead);
      this.assertHandle("read", page.terminalHandle, handle, result);
      state.cursor = page.cursor;
      for (const line of page.terminalLines)
        this.diagnostics.emit({
          kind: "transcript",
          name: "agent",
          context: { ...context, executionId: handle },
          source: "terminal",
          replay: state.replay,
          text: line,
        });
      if (page.terminalLines.length) state.replay = false;
      return page.terminalLines.length;
    } catch (error) {
      if (signal?.aborted) return 200;
      if (!state.warned) {
        state.warned = true;
        this.diagnostics.emit({
          kind: "warning",
          name: "transcript_disabled",
          context: { ...context, executionId: handle },
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
    const handle = this.requireTerminalHandle(references);
    const deadline = Date.now() + 2_000;
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
        context: { ...context, executionId: handle },
      });
  }

  private agentPrompt(launch: TaskLaunch): string {
    const outcomes = launch.allowedOutcomes
      .map((outcome) => `- ${JSON.stringify(outcome)}`)
      .join("\n");
    return `${launch.prompt}\n\n---\nHappy Machine agent instructions (required)\n\n${launch.instructions}\n\nHappy Machine execution context (required)\n\nAttempt identity: ${JSON.stringify(launch.identity)}\nProject workspace: ${JSON.stringify(launch.projectWorkspace)}\nContext file: ${JSON.stringify(launch.contextPath)}\nAttempt number: ${launch.attemptNumber}\nTimeout milliseconds: ${launch.timeoutMs}\n\nHappy Machine result contract (required)\n\nWrite the task result to exactly: ${JSON.stringify(launch.resultPath)}\nThe assigned output directory is: ${JSON.stringify(launch.outputDirectory)}\n\nAllowed outcomes:\n${outcomes}\n\nThe result file must be valid JSON with this structure:\n{\n  "outcome": "<one allowed outcome>",\n  "documents": ["relative/path/to/document.md"],\n  "error": <optional serializable diagnostic data>\n}\n\nEvery declared document must be a Markdown file, and each document path must be relative to the assigned output directory. Only result.json controls the workflow transition; stdout and stderr do not.`;
  }

  private runtimeCommand(
    runtime: TaskLaunch["runtime"],
    reasoning?: string,
  ): string {
    if (!Object.hasOwn(runtimeCommands, runtime))
      throw new TaskExecutorError(
        `Unsupported agent runtime: ${String(runtime)}`,
      );
    if (reasoning === undefined) return runtimeCommands[runtime];
    if (runtime === "codex")
      return `codex -c ${this.posixArgument(
        `model_reasoning_effort=${JSON.stringify(reasoning)}`,
      )}`;
    return `opencode run --interactive --variant ${this.posixArgument(reasoning)}`;
  }

  private posixArgument(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
  }

  private references(
    handle: string,
    legacy?: ExecutorReferences,
  ): ExecutorReferences {
    return {
      ...(legacy ?? {}),
      executionId: handle,
      terminalHandle: handle,
    };
  }

  private terminalHandle(references: ExecutorReferences): string | undefined {
    return references.executionId ?? references.terminalHandle;
  }

  private requireTerminalHandle(references: ExecutorReferences): string {
    const handle = this.terminalHandle(references);
    if (!handle)
      throw new TaskExecutorError(
        "External execution has no terminal handle for terminal-only control",
      );
    return handle;
  }

  private assertHandle(
    operation: string,
    actual: string,
    expected: string,
    result: Pick<CommandResult, "stdout" | "stderr">,
  ): void {
    if (actual !== expected)
      throw new TaskExecutorError(
        `Orca ${operation} returned terminal ${actual} instead of ${expected}`,
        { stdout: result.stdout, stderr: result.stderr },
      );
  }

  private staleTerminal(error: unknown): boolean {
    return (
      error instanceof TaskExecutorError &&
      error.message.includes("terminal_handle_stale")
    );
  }

  private async closeBestEffort(
    terminalHandle: string,
    cwd: string,
    context?: DiagnosticContext,
  ): Promise<void> {
    try {
      await this.run(
        ["terminal", "close", "--terminal", terminalHandle, "--tab", "--json"],
        cwd,
        undefined,
        context,
      );
    } catch {
      // Preserve the launch failure; cleanup is best effort.
    }
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
