import type { WorkflowTaskExecutionRecord } from "./workflow-task.js";

export type RunStatus =
  "running" | "canceling" | "succeeded" | "failed" | "canceled";
export type ControllerStatus = "attached" | "detached";
export type AttemptStatus =
  "launching" | "running" | "timing_out" | "succeeded" | "failed" | "canceled";

export interface AttemptFailure {
  code: string;
  message: string;
}

export type ExternalExecutionStatus = "active" | "stopped" | "unknown";

export interface AttemptReconciliation {
  cancellationRequestedAt: string;
  cancellationCommandCompletedAt?: string;
  observations: Array<{ status: ExternalExecutionStatus; at: string }>;
  confirmedStoppedAt?: string;
}

interface ExecutorReferenceValues {
  executionId?: string;
  runId?: string;
  taskId?: string;
  dispatchId?: string;
  terminalHandle?: string;
}

export type ExecutorReferences = ExecutorReferenceValues &
  ({ executionId: string } | { taskId: string; dispatchId: string });

export type ExternalEventType = "question" | "escalation";
export type ExternalEventStatus = "pending" | "resolved";

export interface ExternalEventRecord {
  id: string;
  type: ExternalEventType;
  status: ExternalEventStatus;
  observedAt: string;
  resolvedAt?: string;
  message?: string;
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
  externalEvents?: ExternalEventRecord[];
  documents: DocumentRecord[];
}

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface TaskRecord {
  id: string;
  attempts: AttemptRecord[];
}

export interface StructuredOutputRecord {
  stateId: string;
  visitNumber: number;
  name: string;
  type: "work_items";
  itemCount: number;
  durablePath: string;
  sha256: string;
}

export interface DynamicTaskBinding {
  workItem: { [key: string]: JsonValue };
  source: { stateId: string; visitNumber: number; outputName: string };
}

export interface WorktreeProvenance {
  stateId: string;
  visitNumber: number;
  taskId: string;
}

export interface ManagedWorktreeRecord {
  id: string;
  role: "main" | "parallel_task";
  provenance?: WorktreeProvenance;
  path: string;
  branch: string;
  startingHead: string;
  endingHead: string;
  dirty: boolean;
}

export interface RunWorkspaceRecord {
  mode: "direct" | "worktree";
  worktrees: ManagedWorktreeRecord[];
}

export type WorktreeCleanupDecision = "pending" | "retain" | "cleanup";
export type WorktreeCleanupResult = "removed" | "retained_dirty" | "failed";

export interface WorktreeCleanupEvaluation {
  worktreeId: string;
  path: string;
  dirty: boolean;
  result: WorktreeCleanupResult;
  evaluatedAt: string;
  message?: string;
}

export interface RunCleanupRecord {
  promptShownAt?: string;
  decision?: WorktreeCleanupDecision;
  decidedAt?: string;
  evaluations: WorktreeCleanupEvaluation[];
}

export interface TaskWorkspaceRecord {
  mode: "direct" | "worktree";
  path: string;
  worktreeId?: string;
  branch?: string;
  startingHead?: string;
  endingHead?: string;
  dirty?: boolean;
}

export interface NormalVisitRecord {
  type: "agent";
  stateId: string;
  number: number;
  contextPath: string;
  task: TaskRecord;
  outcome?: string;
  target?: string;
  outputs?: StructuredOutputRecord[];
}

export type ParallelTaskStatus =
  "queued" | "running" | "succeeded" | "failed" | "canceled";

export interface ParallelTaskRecord extends TaskRecord {
  status: ParallelTaskStatus;
  outcome?: "succeeded";
  failure?: AttemptFailure;
  documents: DocumentRecord[];
  workspace: TaskWorkspaceRecord;
  dynamic?: DynamicTaskBinding;
  /** Optional on disk for compatibility with v1 snapshots. Missing means agent. */
  execution?: { type: "agent" } | WorkflowTaskExecutionRecord;
}

export interface ParallelVisitRecord {
  type: "parallel";
  stateId: string;
  number: number;
  contextPath: string;
  fanOutHead?: string;
  tasks: ParallelTaskRecord[];
  outcome?: "succeeded" | "failed";
  target?: string;
  dynamicSource?: DynamicTaskBinding["source"];
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

export function parallelTaskWorkType(
  task: ParallelTaskRecord,
): "agent" | "workflow" {
  return task.execution?.type ?? "agent";
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

export interface RunCancellationRecord {
  requestedAt: string;
  completedAt?: string;
}

export interface RunRecord {
  id: string;
  workflowId: string;
  workflowPath: string;
  projectRoot: string;
  workspace?: RunWorkspaceRecord;
  definitionSnapshot: DefinitionSnapshotRecord;
  status: RunStatus;
  controllerStatus?: ControllerStatus;
  createdAt: string;
  deadlineAt: string;
  transitionCount: number;
  controllerLease?: ControllerLease;
  cancellation?: RunCancellationRecord;
  cleanup?: RunCleanupRecord;
  terminalTarget?: "$succeeded" | "$failed";
  failure?: AttemptFailure;
  visits: VisitRecord[];
  documents: DocumentRecord[];
  structuredOutputs?: StructuredOutputRecord[];
  events: Array<{
    sequence: number;
    type: string;
    at: string;
    data: Record<string, unknown>;
  }>;
}

export function workspaceMode(run: RunRecord): "direct" | "worktree" {
  return run.workspace?.mode ?? "direct";
}

export function mainWorktree(
  run: RunRecord,
): ManagedWorktreeRecord | undefined {
  return run.workspace?.worktrees.find((worktree) => worktree.role === "main");
}

export function parallelTaskWorktree(
  run: RunRecord,
  stateId: string,
  visitNumber: number,
  taskId: string,
): ManagedWorktreeRecord | undefined {
  return run.workspace?.worktrees.find(
    (worktree) =>
      worktree.role === "parallel_task" &&
      worktree.provenance?.stateId === stateId &&
      worktree.provenance.visitNumber === visitNumber &&
      worktree.provenance.taskId === taskId,
  );
}

export function projectWorkspaceForTask(
  run: RunRecord,
  visit: VisitRecord,
  task: TaskRecord,
): string {
  if (workspaceMode(run) === "direct") return run.projectRoot;
  if (visit.type === "agent") {
    const worktree = mainWorktree(run);
    if (!worktree)
      throw new Error(`Run ${run.id} has no prepared main worktree`);
    return worktree.path;
  }
  const parallelTask = visit.tasks.find((candidate) => candidate === task);
  if (!parallelTask)
    throw new Error(`Task ${task.id} does not belong to the parallel visit`);
  if (parallelTask.workspace.mode !== "worktree")
    throw new Error(`Parallel task ${task.id} has no prepared child worktree`);
  return parallelTask.workspace.path;
}

export function recordWorktree(
  run: RunRecord,
  worktree: ManagedWorktreeRecord,
): void {
  run.workspace ??= { mode: "worktree", worktrees: [] };
  if (run.workspace.mode !== "worktree")
    throw new Error("Cannot register a managed worktree in direct mode");
  const existing = run.workspace.worktrees.find(
    (candidate) => candidate.id === worktree.id,
  );
  if (!existing) {
    run.workspace.worktrees.push(worktree);
    return;
  }
  if (
    existing.role !== worktree.role ||
    existing.path !== worktree.path ||
    existing.branch !== worktree.branch ||
    existing.startingHead !== worktree.startingHead ||
    JSON.stringify(existing.provenance) !== JSON.stringify(worktree.provenance)
  )
    throw new Error(`Managed worktree identity changed for ${worktree.id}`);
  existing.endingHead = worktree.endingHead;
  existing.dirty = worktree.dirty;
}

export function recordWorktreeObservation(
  run: RunRecord,
  worktreeId: string,
  endingHead: string,
  dirty: boolean,
): ManagedWorktreeRecord {
  const worktree = run.workspace?.worktrees.find(
    (candidate) => candidate.id === worktreeId,
  );
  if (!worktree)
    throw new Error(`Run ${run.id} has no managed worktree ${worktreeId}`);
  worktree.endingHead = endingHead;
  worktree.dirty = dirty;
  for (const visit of run.visits) {
    if (visit.type !== "parallel") continue;
    const task = visit.tasks.find(
      (candidate) => candidate.workspace.worktreeId === worktreeId,
    );
    if (!task) continue;
    task.workspace.endingHead = endingHead;
    task.workspace.dirty = dirty;
  }
  return worktree;
}

export function taskWorkspaceFromWorktree(
  worktree: ManagedWorktreeRecord,
): TaskWorkspaceRecord {
  return {
    mode: "worktree",
    path: worktree.path,
    worktreeId: worktree.id,
    branch: worktree.branch,
    startingHead: worktree.startingHead,
    endingHead: worktree.endingHead,
    dirty: worktree.dirty,
  };
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

export function runIsTerminal(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}
