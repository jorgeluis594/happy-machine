import type {
  ExecutorReferences,
  ExternalExecutionStatus,
} from "../domain/execution/run.js";

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

export type RecoveryObservation =
  | { status: "not_found" }
  | {
      status:
        "active" | "completed" | "failed" | "start_unknown" | "stop_unknown";
      references: ExecutorReferences;
      logs: { stdout: string; stderr: string };
    };

export interface TaskExecutor {
  recover?(
    identity: string,
    references: ExecutorReferences | undefined,
    projectWorkspace: string,
  ): Promise<RecoveryObservation>;
  execute(
    launch: TaskLaunch,
    onStarted: (references: ExecutorReferences) => Promise<void>,
  ): Promise<TaskExecution>;
  cancel(
    references: ExecutorReferences,
    projectWorkspace: string,
  ): Promise<void>;
  reconcile(
    references: ExecutorReferences,
    projectWorkspace: string,
  ): Promise<ExternalExecutionStatus>;
}

export class TaskExecutorError extends Error {
  readonly code = "executor_failed";

  constructor(
    message: string,
    readonly logs: { stdout: string; stderr: string } = {
      stdout: "",
      stderr: "",
    },
  ) {
    super(message);
  }
}
