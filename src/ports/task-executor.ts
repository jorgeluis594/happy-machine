import type { ExecutorReferences } from "../domain/execution/run.js";

export interface TaskLaunch {
  identity: string;
  projectWorkspace: string;
  contextPath: string;
  outputDirectory: string;
  resultPath: string;
  instructions: string;
  prompt: string;
  model: string;
  timeoutMs: number;
  attemptNumber: number;
}

export interface TaskExecution {
  references: ExecutorReferences;
  logs: { stdout: string; stderr: string };
}

export interface TaskExecutor {
  execute(
    launch: TaskLaunch,
    onStarted: (references: ExecutorReferences) => Promise<void>,
  ): Promise<TaskExecution>;
}
