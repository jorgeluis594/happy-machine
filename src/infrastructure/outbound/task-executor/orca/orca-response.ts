type JsonRecord = Record<string, unknown>;

export interface OrcaFailure {
  code?: string;
  message: string;
  details?: unknown;
}

export interface OrcaTerminalObservation {
  terminalHandle: string;
  active: boolean;
}

export interface OrcaTerminalRead {
  terminalHandle: string;
  status: string;
  cursor?: string | number;
  terminalLines: string[];
}

export class OrcaResponseError extends Error {}

export function assertOrcaSuccess(value: unknown, operation: string): void {
  resultRecord(value, operation);
}

export function decodeOrcaFailure(value: unknown): OrcaFailure | undefined {
  const envelope = optionalRecord(value);
  if (envelope?.ok !== false) return undefined;
  const error = optionalRecord(envelope.error);
  const code = optionalString(error?.code);
  const message =
    optionalString(error?.message) ??
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
  const message = optionalString(result?.lastError);
  if (!message) return undefined;
  const code =
    optionalString(result?.failedStage) ??
    optionalString(result?.stage) ??
    optionalString(result?.state);
  return { ...(code ? { code } : {}), message };
}

export function decodeTerminalCreate(value: unknown): {
  terminalHandle: string;
} {
  const operation = "create";
  const terminal = requiredRecord(
    resultRecord(value, operation).terminal,
    operation,
    "result.terminal",
  );
  return {
    terminalHandle: requiredString(
      terminal.handle,
      operation,
      "result.terminal.handle",
    ),
  };
}

export function decodeTerminalSend(value: unknown): {
  terminalHandle: string;
  accepted: boolean;
  bytesWritten?: number;
} {
  const operation = "send";
  const send = requiredRecord(
    resultRecord(value, operation).send,
    operation,
    "result.send",
  );
  const bytesWritten = optionalNonNegativeNumber(
    send.bytesWritten,
    operation,
    "result.send.bytesWritten",
  );
  return {
    terminalHandle: requiredString(
      send.handle,
      operation,
      "result.send.handle",
    ),
    accepted: requiredBoolean(send.accepted, operation, "result.send.accepted"),
    ...(bytesWritten === undefined ? {} : { bytesWritten }),
  };
}

export function decodeTerminalShow(value: unknown): OrcaTerminalObservation {
  const operation = "show";
  const terminal = requiredRecord(
    resultRecord(value, operation).terminal,
    operation,
    "result.terminal",
  );
  const connected = requiredBoolean(
    terminal.connected,
    operation,
    "result.terminal.connected",
  );
  const orphaned = optionalBoolean(
    terminal.orphaned,
    operation,
    "result.terminal.orphaned",
  );
  return {
    terminalHandle: requiredString(
      terminal.handle,
      operation,
      "result.terminal.handle",
    ),
    active: connected && orphaned !== true,
  };
}

export function decodeTerminalRead(value: unknown): OrcaTerminalRead {
  const operation = "read";
  const terminal = requiredRecord(
    resultRecord(value, operation).terminal,
    operation,
    "result.terminal",
  );
  if (
    !Array.isArray(terminal.tail) ||
    !terminal.tail.every((line) => typeof line === "string")
  )
    throw invalid(operation, "result.terminal.tail to be an array of strings");
  const cursor = terminal.nextCursor;
  if (
    cursor !== undefined &&
    cursor !== null &&
    typeof cursor !== "string" &&
    typeof cursor !== "number"
  )
    throw invalid(
      operation,
      "result.terminal.nextCursor to be a string or number",
    );
  return {
    terminalHandle: requiredString(
      terminal.handle,
      operation,
      "result.terminal.handle",
    ),
    status: requiredString(
      terminal.status,
      operation,
      "result.terminal.status",
    ),
    ...(cursor === undefined || cursor === null ? {} : { cursor }),
    terminalLines: terminal.tail,
  };
}

export function decodeTerminalClose(value: unknown): {
  terminalHandle: string;
} {
  const operation = "close";
  const close = requiredRecord(
    resultRecord(value, operation).close,
    operation,
    "result.close",
  );
  return {
    terminalHandle: requiredString(
      close.handle,
      operation,
      "result.close.handle",
    ),
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
  const found = optionalString(value);
  if (!found) throw invalid(operation, `${path} to be a non-empty string`);
  return found;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredBoolean(
  value: unknown,
  operation: string,
  path: string,
): boolean {
  if (typeof value !== "boolean")
    throw invalid(operation, `${path} to be a boolean`);
  return value;
}

function optionalBoolean(
  value: unknown,
  operation: string,
  path: string,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredBoolean(value, operation, path);
}

function optionalNonNegativeNumber(
  value: unknown,
  operation: string,
  path: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw invalid(operation, `${path} to be a non-negative number`);
  return value;
}

function invalid(operation: string, expectation: string): OrcaResponseError {
  return new OrcaResponseError(
    `Orca ${operation} response expected ${expectation}`,
  );
}
