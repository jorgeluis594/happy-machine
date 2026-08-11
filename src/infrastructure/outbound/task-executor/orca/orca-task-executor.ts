import { spawn } from "node:child_process";
import type { ExecutorReferences } from "../../../../domain/execution/run.js";
import type {
  TaskExecution,
  TaskExecutor,
  TaskLaunch,
} from "../../../../ports/task-executor.js";

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
      const result = await this.run(args, launch.projectWorkspace);
      logs.stdout += result.stdout;
      logs.stderr += result.stderr;
      return result;
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
      throw new Error("Orca task-create response did not contain a task ID");
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
      throw new Error(
        "Orca worker-start response did not contain a dispatch ID",
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
      throw new Error(
        "Orca did not return a successful worker_done event for the attempt",
      );
    return { references, logs };
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
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0)
          return reject(
            new Error(`Orca command failed (${code}): ${stderr.trim()}`),
          );
        try {
          resolve({ stdout, stderr, json: JSON.parse(stdout) });
        } catch {
          reject(new Error("Orca command returned invalid JSON"));
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
