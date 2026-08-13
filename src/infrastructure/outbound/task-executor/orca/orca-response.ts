import type { ExternalEventRecord } from "../../../../domain/execution/run.js";

type JsonRecord = Record<string, unknown>;

export type OrcaWorkerState =
  | "starting"
  | "ready"
  | "start_unknown"
  | "failed"
  | "succeeded"
  | "stopping"
  | "stop_unknown"
  | "stopped"
  | "abandoned";

export interface OrcaFailure {
  code?: string;
  message: string;
  details?: unknown;
}

export interface OrcaTaskCandidate {
  taskId: string;
  attemptIdentity?: string;
}

export interface OrcaDispatchObservation {
  dispatchId: string;
  taskId: string;
  workerState: OrcaWorkerState;
  terminalHandle?: string;
  runId?: string;
}

export interface OrcaCheckObservation {
  completion?: { dispatchId: string; outcome: "succeeded" | "failed" };
  events: ExternalEventRecord[];
}

const WORKER_STATES = new Set<OrcaWorkerState>([
  "starting",
  "ready",
  "start_unknown",
  "failed",
  "succeeded",
  "stopping",
  "stop_unknown",
  "stopped",
  "abandoned",
]);

export class OrcaResponseError extends Error {}

export function assertOrcaSuccess(value: unknown, operation: string): void {
  resultRecord(value, operation);
}

export function decodeOrcaFailure(value: unknown): OrcaFailure | undefined {
  const envelope = optionalRecord(value);
  if (envelope?.ok !== false) return undefined;
  const error = optionalRecord(envelope.error);
  const code = optionalStringValue(error?.code);
  const message =
    optionalStringValue(error?.message) ??
    "Orca returned an unsuccessful RPC response";
  const details = error?.details ?? error?.data;
  return {
    ...(code ? { code } : {}),
    message,
    ...(details === undefined ? {} : { details }),
  };
}

export function decodeOrcaProcessFailure(
  value: unknown,
): OrcaFailure | undefined {
  const failure = decodeOrcaFailure(value);
  if (failure) return failure;
  const envelope = optionalRecord(value);
  if (envelope?.ok !== true) return undefined;
  const result = optionalRecord(envelope.result);
  const message = optionalStringValue(result?.lastError);
  if (!message) return undefined;
  const code =
    optionalStringValue(result?.failedStage) ??
    optionalStringValue(result?.stage) ??
    optionalStringValue(result?.state);
  return { ...(code ? { code } : {}), message };
}

export function decodeRunCreate(value: unknown): { runId: string } {
  const operation = "run-create";
  const result = resultRecord(value, operation);
  const run = requiredRecord(result.run, operation, "result.run");
  return { runId: requiredString(run.id, operation, "result.run.id") };
}

export function decodeTaskCreate(value: unknown): { taskId: string } {
  const operation = "task-create";
  const result = resultRecord(value, operation);
  const task = requiredRecord(result.task, operation, "result.task");
  return { taskId: requiredString(task.id, operation, "result.task.id") };
}

export function decodeWorkerStart(value: unknown): {
  taskId: string;
  dispatchId: string;
  terminalHandle?: string;
  state: OrcaWorkerState;
} {
  const operation = "worker-start";
  const result = resultRecord(value, operation);
  return {
    taskId: requiredString(result.taskId, operation, "result.taskId"),
    dispatchId: requiredString(
      result.dispatchId,
      operation,
      "result.dispatchId",
    ),
    state: requiredWorkerState(result.state, operation, "result.state"),
    ...optionalStringField(
      result.agentTerminalHandle,
      operation,
      "result.agentTerminalHandle",
      "terminalHandle",
    ),
  };
}

export function decodeTaskList(value: unknown): OrcaTaskCandidate[] {
  const operation = "task-list";
  const result = resultRecord(value, operation);
  if (!Array.isArray(result.tasks))
    throw invalid(operation, "result.tasks to be an array");
  return result.tasks.map((value, index) => {
    const task = requiredRecord(value, operation, `result.tasks[${index}]`);
    const taskId = requiredString(
      task.id,
      operation,
      `result.tasks[${index}].id`,
    );
    const attemptIdentity = attemptIdentityFromSpec(task.spec);
    return {
      taskId,
      ...(attemptIdentity ? { attemptIdentity } : {}),
    };
  });
}

export function decodeDispatchShow(
  value: unknown,
): OrcaDispatchObservation | null {
  const operation = "dispatch-show";
  const result = resultRecord(value, operation);
  if (result.dispatch === null) return null;
  const dispatch = requiredRecord(
    result.dispatch,
    operation,
    "result.dispatch",
  );
  return {
    dispatchId: requiredString(dispatch.id, operation, "result.dispatch.id"),
    taskId: requiredString(
      dispatch.task_id,
      operation,
      "result.dispatch.task_id",
    ),
    workerState: requiredWorkerState(
      dispatch.worker_state,
      operation,
      "result.dispatch.worker_state",
    ),
    ...optionalStringField(
      dispatch.agent_terminal_handle,
      operation,
      "result.dispatch.agent_terminal_handle",
      "terminalHandle",
    ),
    ...optionalStringField(result.runId, operation, "result.runId", "runId"),
  };
}

export function decodeWorkerShow(value: unknown): {
  dispatchId: string;
  taskId: string;
  workerState: OrcaWorkerState;
  terminalHandle?: string;
} {
  const operation = "worker-show";
  const result = resultRecord(value, operation);
  const dispatch = requiredRecord(
    result.dispatch,
    operation,
    "result.dispatch",
  );
  const worker = requiredRecord(result.worker, operation, "result.worker");
  return {
    dispatchId: requiredString(dispatch.id, operation, "result.dispatch.id"),
    taskId: requiredString(
      dispatch.task_id,
      operation,
      "result.dispatch.task_id",
    ),
    workerState: requiredWorkerState(
      worker.state,
      operation,
      "result.worker.state",
    ),
    ...optionalStringField(
      worker.agent_terminal_handle,
      operation,
      "result.worker.agent_terminal_handle",
      "terminalHandle",
    ),
  };
}

export function decodeCheck(
  value: unknown,
  expectedDispatchId: string,
): OrcaCheckObservation {
  const operation = "check";
  const result = resultRecord(value, operation);
  if (!Array.isArray(result.messages))
    throw invalid(operation, "result.messages to be an array");
  const events = new Map<string, ExternalEventRecord>();
  let completion: OrcaCheckObservation["completion"];

  for (const candidate of result.messages) {
    const message = optionalRecord(candidate);
    if (!message) continue;
    const rawType = optionalStringValue(message.type);
    if (!rawType) continue;
    const payload = messagePayload(message.payload);

    if (rawType === "worker_done") {
      const dispatchId =
        optionalStringValue(payload?.dispatchId) ??
        optionalStringValue(payload?.dispatch_id) ??
        optionalStringValue(message.dispatchId) ??
        optionalStringValue(message.dispatch_id);
      const outcome =
        optionalStringValue(payload?.outcome) ??
        optionalStringValue(message.outcome);
      if (
        dispatchId === expectedDispatchId &&
        (outcome === "succeeded" || outcome === "failed")
      )
        completion = { dispatchId, outcome };
      continue;
    }

    const type = rawType.includes("question")
      ? "question"
      : rawType.includes("escalation")
        ? "escalation"
        : undefined;
    if (!type) continue;
    const id =
      optionalStringValue(payload?.[`${type}Id`]) ??
      optionalStringValue(payload?.[`${type}_id`]) ??
      optionalStringValue(message[`${type}Id`]) ??
      optionalStringValue(message[`${type}_id`]) ??
      optionalStringValue(message.id);
    if (!id) continue;
    const rawStatus =
      optionalStringValue(payload?.status) ??
      optionalStringValue(payload?.state) ??
      optionalStringValue(message.status) ??
      optionalStringValue(message.state);
    const resolved =
      rawType.includes("resolved") ||
      ["answered", "approved", "resolved", "closed"].includes(rawStatus ?? "");
    const existing = events.get(id);
    const observedAt = new Date().toISOString();
    const text = messageText(message, payload);
    const event: ExternalEventRecord = {
      id,
      type,
      status: resolved ? "resolved" : "pending",
      observedAt,
      ...(resolved ? { resolvedAt: observedAt } : {}),
      ...(text ? { message: text } : {}),
    };
    if (!existing || event.status === "resolved") events.set(id, event);
  }

  return {
    ...(completion ? { completion } : {}),
    events: [...events.values()],
  };
}

function resultRecord(value: unknown, operation: string): JsonRecord {
  const failure = decodeOrcaFailure(value);
  if (failure) {
    const prefix = failure.code ? `${failure.code}: ` : "";
    throw new OrcaResponseError(
      `Orca ${operation} failed: ${prefix}${failure.message}`,
    );
  }
  const envelope = optionalRecord(value);
  if (!envelope || envelope.ok !== true)
    throw invalid(operation, "an RPC envelope with ok=true");
  return requiredRecord(envelope.result, operation, "result");
}

function requiredRecord(
  value: unknown,
  operation: string,
  path: string,
): JsonRecord {
  const record = optionalRecord(value);
  if (!record) throw invalid(operation, `${path} to be an object`);
  return record;
}

function optionalRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as JsonRecord;
}

function requiredString(
  value: unknown,
  operation: string,
  path: string,
): string {
  const found = optionalStringValue(value);
  if (!found) throw invalid(operation, `${path} to be a non-empty string`);
  return found;
}

function optionalStringField<Key extends string>(
  value: unknown,
  operation: string,
  path: string,
  key: Key,
): { [Property in Key]?: string } {
  if (value === undefined || value === null) return {};
  const found = optionalStringValue(value);
  if (!found) throw invalid(operation, `${path} to be a non-empty string`);
  return { [key]: found } as { [Property in Key]?: string };
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredWorkerState(
  value: unknown,
  operation: string,
  path: string,
): OrcaWorkerState {
  const state = requiredString(value, operation, path);
  if (!WORKER_STATES.has(state as OrcaWorkerState))
    throw invalid(operation, `${path} to contain a known worker state`);
  return state as OrcaWorkerState;
}

function attemptIdentityFromSpec(value: unknown): string | undefined {
  let spec = value;
  if (typeof spec === "string") {
    try {
      spec = JSON.parse(spec) as unknown;
    } catch {
      return undefined;
    }
  }
  return optionalStringValue(optionalRecord(spec)?.happyMachineAttemptIdentity);
}

function messagePayload(value: unknown): JsonRecord | undefined {
  if (typeof value === "string") {
    try {
      return optionalRecord(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  return optionalRecord(value);
}

function messageText(
  message: JsonRecord,
  payload: JsonRecord | undefined,
): string | undefined {
  for (const value of [
    payload?.message,
    payload?.question,
    payload?.reason,
    payload?.text,
    message.message,
    message.question,
    message.reason,
    message.text,
    message.body,
    message.subject,
  ]) {
    const found = optionalStringValue(value);
    if (found) return found;
  }
  return undefined;
}

function invalid(operation: string, expectation: string): OrcaResponseError {
  return new OrcaResponseError(
    `Orca ${operation} response expected ${expectation}`,
  );
}
