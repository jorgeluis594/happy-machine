export type RunStatus = "running" | "succeeded" | "failed";
export type AttemptStatus =
  "launching" | "running" | "timing_out" | "succeeded" | "failed";

export interface AttemptFailure {
  code: string;
  message: string;
}

export type ExternalExecutionStatus = "active" | "stopped" | "unknown";

export interface AttemptReconciliation {
  cancellationRequestedAt: string;
  observations: Array<{ status: ExternalExecutionStatus; at: string }>;
  confirmedStoppedAt?: string;
}

export interface ExecutorReferences {
  runId?: string;
  taskId: string;
  dispatchId: string;
  terminalHandle?: string;
}

export interface AttemptRecord {
  id: string;
  number: number;
  status: AttemptStatus;
  controlWorkspace: string;
  contextPath: string;
  outputDirectory: string;
  resultPath: string;
  executor?: ExecutorReferences;
  logs: { stdout: string; stderr: string };
  outcome?: string;
  error?: JsonValue;
  failure?: AttemptFailure;
  externalStatus?: ExternalExecutionStatus;
  reconciliation?: AttemptReconciliation;
  documents: DocumentRecord[];
}

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface TaskRecord {
  id: string;
  attempts: AttemptRecord[];
}

export interface NormalVisitRecord {
  type: "agent";
  stateId: string;
  number: number;
  contextPath: string;
  task: TaskRecord;
  outcome?: string;
  target?: string;
}

export type ParallelTaskStatus = "queued" | "running" | "succeeded" | "failed";

export interface ParallelTaskRecord extends TaskRecord {
  status: ParallelTaskStatus;
  outcome?: "succeeded";
  failure?: AttemptFailure;
  documents: DocumentRecord[];
  workspace: { mode: "direct"; path: string };
}

export interface ParallelVisitRecord {
  type: "parallel";
  stateId: string;
  number: number;
  contextPath: string;
  tasks: ParallelTaskRecord[];
  outcome?: "succeeded" | "failed";
  target?: string;
}

export type VisitRecord = NormalVisitRecord | ParallelVisitRecord;

export function calculateParallelOutcome(
  tasks: readonly ParallelTaskRecord[],
): "succeeded" | "failed" {
  if (
    tasks.some((task) => task.status === "queued" || task.status === "running")
  )
    throw new Error(
      "Cannot calculate a parallel outcome before every task settles",
    );
  return tasks.every((task) => task.status === "succeeded")
    ? "succeeded"
    : "failed";
}

export interface DocumentRecord {
  stateId: string;
  visitNumber: number;
  taskId: string;
  name: string;
  internalPath: string;
  durablePath: string;
  sha256: string;
}

export interface SnapshotInputRecord {
  id: string;
  originalName: string;
  internalPath: string;
  durablePath: string;
  sha256: string;
}

export interface DefinitionSnapshotRecord {
  identity: string;
  directory: string;
  manifestPath: string;
  inputs: SnapshotInputRecord[];
}

export interface RunRecord {
  id: string;
  workflowId: string;
  workflowPath: string;
  projectRoot: string;
  definitionSnapshot: DefinitionSnapshotRecord;
  status: RunStatus;
  createdAt: string;
  terminalTarget?: "$succeeded" | "$failed";
  failure?: AttemptFailure;
  visits: VisitRecord[];
  documents: DocumentRecord[];
  events: Array<{
    sequence: number;
    type: string;
    at: string;
    data: Record<string, unknown>;
  }>;
}

export function terminalStatus(target: string): RunStatus {
  if (target === "$succeeded") return "succeeded";
  if (target === "$failed") return "failed";
  throw new Error(`Unsupported transition target: ${target}`);
}
