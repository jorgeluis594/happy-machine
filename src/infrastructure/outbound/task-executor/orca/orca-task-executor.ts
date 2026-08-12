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
      const task = this.findObjectContaining(listed.json, identity);
      taskId = task
        ? this.findString(task, ["taskId", "task_id", "id"])
        : undefined;
      if (!taskId) return { status: "not_found" };
    }
    const shown = await this.run(
      ["orchestration", "dispatch-show", "--task", taskId, "--json"],
      projectWorkspace,
    );
    const events = this.externalEvents(shown.json);
    const dispatchId =
      references?.dispatchId ??
      this.findString(shown.json, ["dispatchId", "dispatch_id"]);
    if (!dispatchId)
      return {
        status: "start_unknown",
        references: {
          taskId,
          dispatchId: `unknown:${identity}`,
          runId: references?.runId,
        },
        logs: {
          stdout: lookupLogs.stdout + shown.stdout,
          stderr: lookupLogs.stderr + shown.stderr,
        },
        events,
      };
    const recoveredReferences: ExecutorReferences = {
      taskId,
      dispatchId,
      runId:
        references?.runId ?? this.findString(shown.json, ["runId", "run_id"]),
      terminalHandle:
        references?.terminalHandle ??
        this.findString(shown.json, ["agentTerminalHandle", "terminalHandle"]),
    };
    const state = this.findString(shown.json, ["workerState", "state"]);
    const logs = {
      stdout: lookupLogs.stdout + shown.stdout,
      stderr: lookupLogs.stderr + shown.stderr,
    };
    if (state === "start_unknown" || state === "stop_unknown")
      return { status: state, references: recoveredReferences, logs, events };
    if (["succeeded", "stopped"].includes(state ?? ""))
      return {
        status: "completed",
        references: recoveredReferences,
        logs,
        events,
      };
    if (["failed", "abandoned"].includes(state ?? ""))
      return {
        status: "failed",
        references: recoveredReferences,
        logs,
        events,
      };
    if (["starting", "ready", "stopping"].includes(state ?? ""))
      return {
        status: "active",
        references: recoveredReferences,
        logs,
        events,
      };
    return {
      status: "start_unknown",
      references: recoveredReferences,
      logs,
      events,
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
      prompt: launch.prompt,
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
    const taskReceipt = await command([
      "orchestration",
      "task-create",
      "--spec",
      contract,
      "--json",
    ]);
    const orcaRunId = this.findString(runReceipt.json, [
      "runId",
      "run_id",
      "id",
    ]);
    const taskId = this.findString(taskReceipt.json, [
      "taskId",
      "task_id",
      "id",
    ]);
    if (!taskId)
      throw new TaskExecutorError(
        "Orca task-create response did not contain a task ID",
        logs,
      );
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
    const dispatchId = this.findString(workerReceipt.json, [
      "dispatchId",
      "dispatch_id",
      "id",
    ]);
    const terminalHandle = this.findString(workerReceipt.json, [
      "agentTerminalHandle",
      "terminalHandle",
      "handle",
    ]);
    if (!dispatchId)
      throw new TaskExecutorError(
        "Orca worker-start response did not contain a dispatch ID",
        logs,
      );
    const references: ExecutorReferences = {
      runId: orcaRunId,
      taskId,
      dispatchId,
      terminalHandle,
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
      for (const event of this.externalEvents(completion.json)) {
        const previous = observedEvents.get(event.id);
        if (previous?.status === event.status) continue;
        observedEvents.set(event.id, event);
        await onEvent?.(event);
      }
      if (this.hasCompletion(completion.json, dispatchId)) break;
      if (!this.externalEvents(completion.json).length)
        throw new TaskExecutorError(
          "Orca check returned without completion or a structured intervention event",
          logs,
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
    const state = this.findString(result.json, ["workerState", "state"]);
    if (["failed", "succeeded", "stopped"].includes(state ?? ""))
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
        reject(new TaskExecutorError(error.message, { stdout, stderr })),
      );
      child.on("close", (code) => {
        signal?.removeEventListener("abort", stopObserving);
        if (code !== 0)
          return reject(
            new TaskExecutorError(
              `Orca command failed (${code}): ${stderr.trim()}`,
              { stdout, stderr },
            ),
          );
        try {
          resolve({ stdout, stderr, json: JSON.parse(stdout) });
        } catch {
          reject(
            new TaskExecutorError("Orca command returned invalid JSON", {
              stdout,
              stderr,
            }),
          );
        }
      });
    });
  }

  private findString(value: unknown, keys: string[]): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    for (const key of keys) {
      const found = (value as Record<string, unknown>)[key];
      if (typeof found === "string") return found;
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child))
        for (const item of child) {
          const found = this.findString(item, keys);
          if (found) return found;
        }
      else {
        const found = this.findString(child, keys);
        if (found) return found;
      }
    }
    return undefined;
  }

  private findObjectContaining(
    value: unknown,
    text: string,
  ): Record<string, unknown> | undefined {
    if (!value || typeof value !== "object") return undefined;
    if (!Array.isArray(value) && JSON.stringify(value).includes(text))
      return value as Record<string, unknown>;
    for (const child of Object.values(value)) {
      const found = this.findObjectContaining(child, text);
      if (found) return found;
    }
    return undefined;
  }

  private hasCompletion(value: unknown, dispatchId: string): boolean {
    const text = JSON.stringify(value);
    return (
      text.includes(dispatchId) &&
      text.includes("worker_done") &&
      text.includes("succeeded")
    );
  }

  private externalEvents(value: unknown): ExternalEventRecord[] {
    const objects: Array<Record<string, unknown>> = [];
    const collect = (candidate: unknown): void => {
      if (!candidate || typeof candidate !== "object") return;
      if (!Array.isArray(candidate))
        objects.push(candidate as Record<string, unknown>);
      for (const child of Object.values(candidate)) collect(child);
    };
    collect(value);
    const events = new Map<string, ExternalEventRecord>();
    for (const object of objects) {
      const rawType = typeof object.type === "string" ? object.type : undefined;
      if (!rawType) continue;
      const type = rawType.includes("question")
        ? "question"
        : rawType.includes("escalation")
          ? "escalation"
          : undefined;
      if (!type) continue;
      const id = this.findString(object, [
        `${type}Id`,
        `${type}_id`,
        "eventId",
        "event_id",
        "id",
      ]);
      if (!id) continue;
      const rawStatus = this.findString(object, ["status", "state"]);
      const resolved =
        rawType.includes("resolved") ||
        ["answered", "approved", "resolved", "closed"].includes(
          rawStatus ?? "",
        );
      const existing = events.get(id);
      const observedAt = new Date().toISOString();
      const event: ExternalEventRecord = {
        id,
        type,
        status: resolved ? "resolved" : "pending",
        observedAt,
        ...(resolved ? { resolvedAt: observedAt } : {}),
        ...(this.findString(object, ["message", "question", "reason", "text"])
          ? {
              message: this.findString(object, [
                "message",
                "question",
                "reason",
                "text",
              ]),
            }
          : {}),
      };
      if (!existing || event.status === "resolved") events.set(id, event);
    }
    return [...events.values()];
  }
}
