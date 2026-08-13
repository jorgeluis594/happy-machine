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
  decodeDispatchShow,
  decodeOrcaProcessFailure,
  decodeRunCreate,
  decodeTaskCreate,
  decodeTaskList,
  decodeWorkerShow,
  decodeWorkerStart,
  OrcaResponseError,
} from "./orca-response.js";

interface CommandResult {
  stdout: string;
  stderr: string;
  json: unknown;
}

export class OrcaTaskExecutor implements TaskExecutor {
  constructor(
    private readonly executable = process.env.ORCA_CLI_COMMAND || "orca",
  ) {}

  async recover(
    identity: string,
    references: ExecutorReferences | undefined,
    projectWorkspace: string,
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
    const workerReceipt = await command([
      "orchestration",
      "worker-start",
      "--task",
      taskId,
      "--worktree",
      "current",
      "--agent",
      "codex",
      "--model",
      launch.model,
      "--json",
    ]);
    const worker = this.decode(workerReceipt, decodeWorkerStart, logs);
    if (worker.taskId !== taskId)
      throw new TaskExecutorError(
        `Orca worker-start returned task ${worker.taskId} instead of created task ${taskId}`,
        { ...logs },
      );
    if (worker.state !== "ready")
      throw new TaskExecutorError(
        `Orca worker-start returned non-ready state ${worker.state}`,
        { ...logs },
      );
    const references: ExecutorReferences = {
      runId: orcaRunId,
      taskId,
      dispatchId: worker.dispatchId,
      terminalHandle: worker.terminalHandle,
    };
    await onStarted(references);
    const observedEvents = new Map<string, ExternalEventRecord>();
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
    return { references, logs };
  }

  async cancel(
    references: ExecutorReferences,
    projectWorkspace: string,
  ): Promise<void> {
    await this.run(
      [
        "orchestration",
        "worker-stop",
        "--dispatch",
        references.dispatchId,
        "--json",
      ],
      projectWorkspace,
    );
  }

  async reconcile(
    references: ExecutorReferences,
    projectWorkspace: string,
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
    );
    const worker = this.decode(result, decodeWorkerShow);
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
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const operation = args[1] ?? args[0] ?? "command";
      const child = spawn(this.executable, args, { cwd, env: process.env });
      const stopObserving = () => child.kill("SIGTERM");
      if (signal?.aborted) stopObserving();
      else signal?.addEventListener("abort", stopObserving, { once: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) =>
        reject(
          new TaskExecutorError(
            `Orca ${operation} failed to start: ${error.message}`,
            { stdout, stderr },
          ),
        ),
      );
      child.on("close", (code) => {
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

  private effectivePrompt(launch: TaskLaunch): string {
    const outcomes = launch.allowedOutcomes
      .map((outcome) => `- ${JSON.stringify(outcome)}`)
      .join("\n");
    return `${launch.prompt}\n\n---\nHappy Machine result contract (required)\n\nWrite the task result to exactly: ${JSON.stringify(launch.resultPath)}\nThe assigned output directory is: ${JSON.stringify(launch.outputDirectory)}\n\nAllowed outcomes:\n${outcomes}\n\nThe result file must be valid JSON with this structure:\n{\n  "outcome": "<one allowed outcome>",\n  "documents": ["relative/path/to/document.md"],\n  "error": <optional serializable diagnostic data>\n}\n\nEvery declared document must be a Markdown file, and each document path must be relative to the assigned output directory. Only result.json controls the workflow transition; stdout and stderr do not.`;
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
