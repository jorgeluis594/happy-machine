export type RunStatus = "running" | "succeeded" | "failed" | "canceled";
export type ControllerStatus = "attached" | "detached";
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
  startedAt?: string;
  deadlineAt?: string;
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
  controllerStatus?: ControllerStatus;
  createdAt: string;
  deadlineAt: string;
  transitionCount: number;
  controllerLease?: ControllerLease;
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

export interface ControllerLease {
  controllerId: string;
  fencingToken: number;
  durationMs: number;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}

export function leaseIsValid(
  lease: ControllerLease | undefined,
  observedAt: string,
): boolean {
  return (
    lease !== undefined && Date.parse(observedAt) < Date.parse(lease.expiresAt)
  );
}

export function acquireControllerLease(
  previous: ControllerLease | undefined,
  controllerId: string,
  durationMs: number,
  acquiredAt: string,
): ControllerLease {
  const fencingToken = (previous?.fencingToken ?? 0) + 1;
  return {
    controllerId,
    fencingToken,
    durationMs,
    acquiredAt,
    renewedAt: acquiredAt,
    expiresAt: new Date(Date.parse(acquiredAt) + durationMs).toISOString(),
  };
}

export function renewControllerLease(
  lease: ControllerLease,
  renewedAt: string,
): ControllerLease {
  return {
    ...lease,
    renewedAt,
    expiresAt: new Date(Date.parse(renewedAt) + lease.durationMs).toISOString(),
  };
}

export type GlobalLimitFailureCode =
  "workflow_timeout" | "max_state_visits_exceeded" | "max_transitions_exceeded";

export type GlobalLimitEvaluation =
  | {
      allowed: true;
      limit: "workflow_timeout";
      effectiveDeadline: string;
      observedAt: string;
    }
  | {
      allowed: false;
      limit: "workflow_timeout";
      effectiveDeadline: string;
      observedAt: string;
      terminalCause: "workflow_timeout";
    }
  | {
      allowed: true;
      limit: "max_state_visits" | "max_transitions";
      effectiveValue: number;
      observedValue: number;
    }
  | {
      allowed: false;
      limit: "max_state_visits";
      effectiveValue: number;
      observedValue: number;
      terminalCause: "max_state_visits_exceeded";
    }
  | {
      allowed: false;
      limit: "max_transitions";
      effectiveValue: number;
      observedValue: number;
      terminalCause: "max_transitions_exceeded";
    };

export function evaluateWorkflowDeadline(
  deadlineAt: string,
  observedAt: string,
): GlobalLimitEvaluation {
  const allowed = Date.parse(observedAt) < Date.parse(deadlineAt);
  return {
    allowed,
    limit: "workflow_timeout",
    effectiveDeadline: deadlineAt,
    observedAt,
    ...(allowed ? {} : { terminalCause: "workflow_timeout" as const }),
  } as GlobalLimitEvaluation;
}

export function evaluateStateVisitLimit(
  effectiveValue: number,
  proposedVisit: number,
): GlobalLimitEvaluation {
  const allowed = proposedVisit <= effectiveValue;
  return {
    allowed,
    limit: "max_state_visits",
    effectiveValue,
    observedValue: proposedVisit,
    ...(allowed ? {} : { terminalCause: "max_state_visits_exceeded" as const }),
  } as GlobalLimitEvaluation;
}

export function evaluateTransitionLimit(
  effectiveValue: number,
  proposedTransition: number,
): GlobalLimitEvaluation {
  const allowed = proposedTransition <= effectiveValue;
  return {
    allowed,
    limit: "max_transitions",
    effectiveValue,
    observedValue: proposedTransition,
    ...(allowed ? {} : { terminalCause: "max_transitions_exceeded" as const }),
  } as GlobalLimitEvaluation;
}

export function terminalStatus(target: string): RunStatus {
  if (target === "$succeeded") return "succeeded";
  if (target === "$failed") return "failed";
  throw new Error(`Unsupported transition target: ${target}`);
}
