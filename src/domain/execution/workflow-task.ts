import type { AttemptRecord, DocumentRecord, JsonValue } from "./run.js";

export type WorkflowTaskPhase =
  "queued" | "child_running" | "evaluating" | "succeeded" | "failed";

export interface WorkflowTaskCoordinate {
  parentRunId: string;
  stateId: string;
  visitNumber: number;
  taskId: string;
}

export interface ParentRunReference {
  runId: string;
  stateId: string;
  visitNumber: number;
  taskId: string;
}

export interface StructuredOutputReference {
  stateId: string;
  visitNumber: number;
  name: string;
  value: JsonValue;
}

export interface WorkflowTaskEnvelope {
  id: string;
  childRunId: string;
  status: "succeeded" | "failed";
  outputs: Record<string, StructuredOutputReference>;
  documents: DocumentRecord[];
  error?: JsonValue;
}

export interface WorkflowTaskExecutionRecord {
  type: "workflow";
  phase: WorkflowTaskPhase;
  coordinate: WorkflowTaskCoordinate;
  childRunId: string;
  resolvedWith: Record<string, JsonValue>;
  childController?: {
    executionId: string;
    logs?: { stdout: string; stderr: string };
  };
  evaluationAttempts: AttemptRecord[];
  result?: WorkflowTaskEnvelope;
}

export interface EvaluatorPolicy {
  attemptTimeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
}

export const workflowTaskEvaluatorPolicy: EvaluatorPolicy = {
  attemptTimeoutMs: 30 * 60_000,
  maxAttempts: 3,
  retryDelayMs: 5_000,
};

const transitions: Record<WorkflowTaskPhase, readonly WorkflowTaskPhase[]> = {
  queued: ["child_running"],
  child_running: ["evaluating"],
  evaluating: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

export function sameWorkflowTaskCoordinate(
  left: WorkflowTaskCoordinate,
  right: WorkflowTaskCoordinate,
): boolean {
  return (
    left.parentRunId === right.parentRunId &&
    left.stateId === right.stateId &&
    left.visitNumber === right.visitNumber &&
    left.taskId === right.taskId
  );
}

export function transitionWorkflowTask(
  phase: WorkflowTaskPhase,
  next: WorkflowTaskPhase,
): WorkflowTaskPhase {
  if (!transitions[phase].includes(next))
    throw new Error(`Invalid workflow task transition: ${phase} -> ${next}`);
  return next;
}

export function reserveWorkflowChild(
  task: WorkflowTaskExecutionRecord,
  childRunId: string,
  coordinate: WorkflowTaskCoordinate,
): WorkflowTaskExecutionRecord {
  if (!sameWorkflowTaskCoordinate(task.coordinate, coordinate))
    throw new Error("Workflow task coordinate changed");
  if (task.childRunId !== childRunId)
    throw new Error("Workflow task child identity changed");
  return task;
}

export function settleWorkflowTask(
  task: WorkflowTaskExecutionRecord,
  envelope: WorkflowTaskEnvelope,
): WorkflowTaskExecutionRecord {
  if (
    envelope.childRunId !== task.childRunId ||
    envelope.id !== task.coordinate.taskId
  )
    throw new Error(
      "Workflow task envelope provenance does not match its task",
    );
  if (task.phase !== "evaluating")
    throw new Error("Workflow task can only settle from evaluating");
  return { ...task, phase: envelope.status, result: structuredClone(envelope) };
}

export function canJoinWorkflowTasks(
  tasks: readonly WorkflowTaskExecutionRecord[],
): boolean {
  return tasks.every(
    (task) => task.phase === "succeeded" || task.phase === "failed",
  );
}
