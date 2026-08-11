import { spawn } from "node:child_process";
import type {
  ExecutorReferences,
  ExternalExecutionStatus,
} from "../../../../domain/execution/run.js";
import type {
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

  async execute(
    launch: TaskLaunch,
    onStarted: (references: ExecutorReferences) => Promise<void>,
  ): Promise<TaskExecution> {
    const logs = { stdout: "", stderr: "" };
    const command = async (args: string[]): Promise<CommandResult> => {
      try {
        const result = await this.run(args, launch.projectWorkspace);
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
    if (!this.hasCompletion(completion.json, dispatchId))
      throw new TaskExecutorError(
        "Orca did not return a successful worker_done event for the attempt",
        logs,
      );
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

  private run(args: string[], cwd: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, { cwd, env: process.env });
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

  private hasCompletion(value: unknown, dispatchId: string): boolean {
    const text = JSON.stringify(value);
    return (
      text.includes(dispatchId) &&
      text.includes("worker_done") &&
      text.includes("succeeded")
    );
  }
}
