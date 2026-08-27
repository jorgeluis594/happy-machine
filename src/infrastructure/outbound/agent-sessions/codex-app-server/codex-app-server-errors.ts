import {
  AgentRuntimeIncompatibleError,
  AgentRuntimeUnavailableError,
} from "../../../../ports/agent-sessions.js";
import {
  CodexJsonRpcClientError,
  CodexJsonRpcRemoteError,
} from "./codex-json-rpc-client.js";
import { CodexProcessRuntimeError } from "./codex-process-runtime.js";

export type CodexAppServerSessionsErrorCode =
  "invalid_state" | "protocol_error" | "operation_failed" | "cleanup_failed";

export class CodexAppServerSessionsError extends Error {
  override readonly name = "CodexAppServerSessionsError";

  constructor(
    readonly code: CodexAppServerSessionsErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

export function mapCompatibilityError(error: unknown): Error {
  if (error instanceof AgentRuntimeUnavailableError) return error;
  if (error instanceof AgentRuntimeIncompatibleError) return error;
  if (error instanceof CodexProcessRuntimeError) {
    if (error.code === "unavailable")
      return new AgentRuntimeUnavailableError(
        "The Codex executable is unavailable.",
        { cause: error, cleanupFailures: error.cleanupFailures },
      );
    return new AgentRuntimeIncompatibleError(
      "Codex does not provide the app-server capabilities required by create-skill.",
      { cause: error, cleanupFailures: error.cleanupFailures },
    );
  }
  return new AgentRuntimeUnavailableError(
    "The Codex runtime could not be checked.",
    { cause: error },
  );
}

export function mapStartupError(
  error: unknown,
): AgentRuntimeUnavailableError | AgentRuntimeIncompatibleError {
  if (error instanceof AgentRuntimeUnavailableError) return error;
  if (error instanceof AgentRuntimeIncompatibleError) return error;
  if (error instanceof CodexProcessRuntimeError) {
    return error.code === "unavailable" || error.code === "spawn_failed"
      ? new AgentRuntimeUnavailableError(
          "The Codex app-server runtime could not be started.",
          { cause: error, cleanupFailures: error.cleanupFailures },
        )
      : new AgentRuntimeIncompatibleError(
          "Codex could not establish the required app-server control connection.",
          { cause: error, cleanupFailures: error.cleanupFailures },
        );
  }
  return new AgentRuntimeIncompatibleError(
    "Codex could not establish the required app-server control connection.",
    { cause: error },
  );
}

export function sessionOperationError(
  operation: string,
  error: unknown,
): CodexAppServerSessionsError {
  if (error instanceof CodexAppServerSessionsError) return error;
  const code =
    (error instanceof CodexJsonRpcClientError &&
      error.code === "protocol_error") ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "protocol_error")
      ? "protocol_error"
      : "operation_failed";
  return new CodexAppServerSessionsError(
    code,
    `The Codex app-server could not ${operation}.`,
    { cause: error },
  );
}

export function cleanupError(errors: readonly unknown[]): Error {
  return new CodexAppServerSessionsError(
    "cleanup_failed",
    "The Codex app-server session runtime did not stop cleanly.",
    { cause: new AggregateError(errors) },
  );
}

export function isUnsupportedEphemeralError(error: unknown): boolean {
  return (
    error instanceof CodexJsonRpcRemoteError && error.remoteCode === -32602
  );
}
