import type {
  ExternalEventRecord,
  ExecutorReferences,
  ExternalExecutionStatus,
} from "../domain/execution/run.js";
import type { DiagnosticContext } from "./diagnostics.js";
import type { AgentRuntime } from "./project-definitions.js";

export interface TaskLaunch {
  identity: string;
  projectWorkspace: string;
  contextPath: string;
  outputDirectory: string;
  resultPath: string;
  instructions: string;
  prompt: string;
  allowedOutcomes: readonly string[];
  runtime: AgentRuntime;
  reasoning?: string;
  timeoutMs: number;
  attemptNumber: number;
  signal?: AbortSignal;
  diagnosticContext?: {
    runId: string;
    stateId: string;
    visitNumber: number;
    taskId: string;
    attemptNumber: number;
  };
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
      events?: ExternalEventRecord[];
    };

export interface TaskExecutor {
  recover?(
    identity: string,
    references: ExecutorReferences | undefined,
    projectWorkspace: string,
    resultPath?: string,
    diagnosticContext?: DiagnosticContext,
  ): Promise<RecoveryObservation>;
  execute(
    launch: TaskLaunch,
    onStarted: (references: ExecutorReferences) => Promise<void>,
    onEvent?: (event: ExternalEventRecord) => Promise<void>,
  ): Promise<TaskExecution>;
  cancel(
    references: ExecutorReferences,
    projectWorkspace: string,
    diagnosticContext?: DiagnosticContext,
  ): Promise<void>;
  reconcile(
    references: ExecutorReferences,
    projectWorkspace: string,
    diagnosticContext?: DiagnosticContext,
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
