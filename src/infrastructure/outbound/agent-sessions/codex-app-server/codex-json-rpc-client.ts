import type { Readable, Writable } from "node:stream";

export type CodexJsonRpcPrimitive = string | number | boolean | null;
export type CodexJsonRpcValue =
  | CodexJsonRpcPrimitive
  | { readonly [key: string]: CodexJsonRpcValue }
  | readonly CodexJsonRpcValue[];

export interface CodexJsonRpcNotification {
  method: string;
  params?: CodexJsonRpcValue;
}

export interface CodexJsonRpcServerRequest extends CodexJsonRpcNotification {
  id: string | number;
}

export interface CodexTurnCompletedNotification {
  threadId: string;
  turn: {
    id: string;
    [key: string]: CodexJsonRpcValue;
  };
  [key: string]: CodexJsonRpcValue;
}

export type CodexJsonRpcNotificationListener = (
  notification: CodexJsonRpcNotification,
) => void;

export type CodexJsonRpcServerRequestHandler = (
  request: CodexJsonRpcServerRequest,
) => CodexJsonRpcValue | Promise<CodexJsonRpcValue>;

export interface CodexJsonRpcClientOptions {
  readable: Readable;
  writable: Writable;
  shutdownTimeoutMs?: number;
  handleServerRequest?: CodexJsonRpcServerRequestHandler;
}

export interface CodexJsonRpcOperationOptions {
  signal?: AbortSignal;
}

export type CodexJsonRpcClientErrorCode =
  | "aborted"
  | "invalid_state"
  | "protocol_error"
  | "remote_error"
  | "shutdown_timeout"
  | "transport_closed";

export class CodexJsonRpcClientError extends Error {
  override readonly name: string = "CodexJsonRpcClientError";

  constructor(
    readonly code: CodexJsonRpcClientErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
  }
}

export class CodexJsonRpcRemoteError extends CodexJsonRpcClientError {
  override readonly name = "CodexJsonRpcRemoteError";

  constructor(
    readonly remoteCode: number,
    message: string,
    readonly data?: CodexJsonRpcValue,
  ) {
    super("remote_error", message);
  }
}

export class CodexJsonRpcShutdownTimeoutError extends CodexJsonRpcClientError {
  override readonly name = "CodexJsonRpcShutdownTimeoutError";

  constructor(readonly timeoutMs: number) {
    super(
      "shutdown_timeout",
      `Codex JSON-RPC transport did not close within ${String(timeoutMs)}ms`,
    );
  }
}

interface PendingRequest {
  method: string;
  resolve: (value: CodexJsonRpcValue) => void;
  reject: (error: CodexJsonRpcClientError) => void;
  removeAbortListener: () => void;
}

interface TurnWaiter {
  resolve: (notification: CodexTurnCompletedNotification) => void;
  reject: (error: CodexJsonRpcClientError) => void;
  removeAbortListener: () => void;
}

type ClientState =
  "new" | "initializing" | "ready" | "failed" | "closing" | "closed";

const defaultShutdownTimeoutMs = 1_000;
const maximumBufferedTurnCompletions = 100;

export class CodexJsonRpcClient {
  private readonly readable: Readable;
  private readonly writable: Writable;
  private readonly shutdownTimeoutMs: number;
  private readonly handleServerRequest?: CodexJsonRpcServerRequestHandler;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Map<
    string,
    Set<CodexJsonRpcNotificationListener>
  >();
  private readonly turnWaiters = new Map<string, Set<TurnWaiter>>();
  private readonly bufferedTurnCompletions = new Map<
    string,
    CodexTurnCompletedNotification
  >();
  private readonly transportEnded: Promise<void>;
  private resolveTransportEnded!: () => void;
  private state: ClientState = "new";
  private nextRequestId = 0;
  private incomingBuffer = "";
  private initialization?: Promise<CodexJsonRpcValue>;
  private terminalError?: CodexJsonRpcClientError;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: CodexJsonRpcClientOptions) {
    if (
      options.shutdownTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.shutdownTimeoutMs) ||
        options.shutdownTimeoutMs <= 0)
    )
      throw new TypeError("shutdownTimeoutMs must be a positive integer");

    this.readable = options.readable;
    this.writable = options.writable;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs;
    this.handleServerRequest = options.handleServerRequest;
    this.transportEnded = new Promise((resolve) => {
      this.resolveTransportEnded = resolve;
    });

    this.readable.setEncoding("utf8");
    this.readable.on("data", this.onData);
    this.readable.once("end", this.onReadableEnd);
    this.readable.once("close", this.onReadableClose);
    this.readable.once("error", this.onReadableError);
    this.writable.once("error", this.onWritableError);
  }

  initialize(
    params: CodexJsonRpcValue = {},
    options: CodexJsonRpcOperationOptions = {},
  ): Promise<CodexJsonRpcValue> {
    if (this.initialization !== undefined) return this.initialization;
    if (this.state !== "new") return Promise.reject(this.stateError());

    this.state = "initializing";
    this.initialization = this.performInitialization(params, options.signal);
    return this.initialization;
  }

  async request<T extends CodexJsonRpcValue = CodexJsonRpcValue>(
    method: string,
    params?: CodexJsonRpcValue,
    options: CodexJsonRpcOperationOptions = {},
  ): Promise<T> {
    this.requireApplicationMethod(method);
    await this.requireReady(options.signal);
    return (await this.sendRequest(method, params, options.signal)) as T;
  }

  async notify(method: string, params?: CodexJsonRpcValue): Promise<void> {
    this.requireApplicationMethod(method);
    await this.requireReady();
    await this.sendNotification(method, params);
  }

  onNotification(
    method: string,
    listener: CodexJsonRpcNotificationListener,
  ): () => void {
    requireMethod(method);
    const listeners = this.notificationListeners.get(method) ?? new Set();
    listeners.add(listener);
    this.notificationListeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.notificationListeners.delete(method);
    };
  }

  waitForTurnCompletion(
    threadId: string,
    turnId: string,
    options: CodexJsonRpcOperationOptions = {},
  ): Promise<CodexTurnCompletedNotification> {
    if (threadId.length === 0 || turnId.length === 0)
      return Promise.reject(
        new CodexJsonRpcClientError(
          "protocol_error",
          "Thread and turn identifiers must be non-empty",
        ),
      );
    if (this.state !== "ready") return Promise.reject(this.stateError());

    const key = turnKey(threadId, turnId);
    const buffered = this.bufferedTurnCompletions.get(key);
    if (buffered !== undefined) {
      this.bufferedTurnCompletions.delete(key);
      return Promise.resolve(buffered);
    }
    if (options.signal?.aborted)
      return Promise.reject(abortError(options.signal.reason));

    return new Promise((resolve, reject) => {
      const waiters = this.turnWaiters.get(key) ?? new Set<TurnWaiter>();
      const waiter: TurnWaiter = {
        resolve,
        reject,
        removeAbortListener: () => {},
      };
      waiter.removeAbortListener = installAbortListener(options.signal, () => {
        waiters.delete(waiter);
        if (waiters.size === 0) this.turnWaiters.delete(key);
        reject(abortError(options.signal?.reason));
      });
      waiters.add(waiter);
      this.turnWaiters.set(key, waiters);
    });
  }

  async shutdown(): Promise<void> {
    if (this.state === "closed") return;

    this.state = "closing";
    this.rejectActiveOperations(
      new CodexJsonRpcClientError(
        "transport_closed",
        "Codex JSON-RPC client is shutting down",
      ),
    );

    if (!this.writable.destroyed && !this.writable.writableEnded)
      this.writable.end();

    let timeout: NodeJS.Timeout | undefined;
    const timeoutError = new CodexJsonRpcShutdownTimeoutError(
      this.shutdownTimeoutMs,
    );
    try {
      await Promise.race([
        this.transportEnded,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(timeoutError),
            this.shutdownTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      this.readable.destroy(timeoutError);
      this.writable.destroy(timeoutError);
      this.state = "closed";
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    this.state = "closed";
  }

  private readonly onData = (chunk: string): void => {
    this.incomingBuffer += chunk;
    while (true) {
      const newline = this.incomingBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.incomingBuffer.slice(0, newline).replace(/\r$/, "");
      this.incomingBuffer = this.incomingBuffer.slice(newline + 1);
      if (line.trim().length > 0) this.handleLine(line);
    }
  };

  private readonly onReadableEnd = (): void => {
    const finalLine = this.incomingBuffer.replace(/\r$/, "");
    this.incomingBuffer = "";
    if (finalLine.trim().length > 0) this.handleLine(finalLine);
    this.finishTransport();
  };

  private readonly onReadableClose = (): void => {
    this.finishTransport();
  };

  private readonly onReadableError = (error: Error): void => {
    this.failClient(transportError("Codex JSON-RPC input failed", error));
    this.finishTransport();
  };

  private readonly onWritableError = (error: Error): void => {
    this.failClient(transportError("Codex JSON-RPC output failed", error));
  };

  private async performInitialization(
    params: CodexJsonRpcValue,
    signal?: AbortSignal,
  ): Promise<CodexJsonRpcValue> {
    try {
      const response = await this.sendRequest("initialize", params, signal);
      await this.sendNotification("initialized", {});
      this.state = "ready";
      return response;
    } catch (error) {
      const clientError = normalizeClientError(
        error,
        "Codex JSON-RPC initialization failed",
      );
      this.terminalError = clientError;
      this.state = "failed";
      throw clientError;
    }
  }

  private async requireReady(signal?: AbortSignal): Promise<void> {
    if (this.state === "initializing" && this.initialization !== undefined)
      await waitWithAbort(this.initialization, signal);
    if (this.state !== "ready") throw this.stateError();
  }

  private sendRequest(
    method: string,
    params: CodexJsonRpcValue | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CodexJsonRpcValue> {
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    const id = ++this.nextRequestId;
    let pending!: PendingRequest;
    const response = new Promise<CodexJsonRpcValue>((resolve, reject) => {
      pending = {
        method,
        resolve,
        reject,
        removeAbortListener: () => {},
      };
      pending.removeAbortListener = installAbortListener(signal, () => {
        if (this.pendingRequests.delete(id)) reject(abortError(signal?.reason));
      });
      this.pendingRequests.set(id, pending);
    });
    const written = this.writeMessage({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }).catch((error: unknown) => {
      const clientError = normalizeClientError(
        error,
        `Could not send Codex JSON-RPC request ${method}`,
      );
      if (this.pendingRequests.delete(id)) {
        pending.removeAbortListener();
        pending.reject(clientError);
      }
      throw clientError;
    });
    return Promise.all([written, response]).then(([, result]) => result);
  }

  private sendNotification(
    method: string,
    params: CodexJsonRpcValue | undefined,
  ): Promise<void> {
    return this.writeMessage({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private writeMessage(
    message: Record<string, CodexJsonRpcValue>,
  ): Promise<void> {
    if (this.state === "closing" || this.state === "closed")
      return Promise.reject(this.stateError());
    const line = `${JSON.stringify(message)}\n`;
    const write = this.writeQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.writable.destroyed || this.writable.writableEnded) {
            reject(
              new CodexJsonRpcClientError(
                "transport_closed",
                "Codex JSON-RPC output is closed",
              ),
            );
            return;
          }
          this.writable.write(line, (error) => {
            if (error)
              reject(transportError("Codex JSON-RPC write failed", error));
            else resolve();
          });
        }),
    );
    this.writeQueue = write.catch(() => {});
    return write;
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch (error) {
      this.failClient(
        new CodexJsonRpcClientError(
          "protocol_error",
          "Codex JSON-RPC transport produced malformed JSON",
          { cause: error },
        ),
      );
      return;
    }
    if (!isRecord(message)) {
      this.failClient(
        protocolError("Codex JSON-RPC message must be an object"),
      );
      return;
    }
    if (message.jsonrpc !== undefined && message.jsonrpc !== "2.0") {
      this.failClient(protocolError("Unsupported JSON-RPC protocol version"));
      return;
    }

    if (Object.hasOwn(message, "method")) {
      if (typeof message.method !== "string" || message.method.length === 0) {
        this.failClient(
          protocolError("JSON-RPC method must be a non-empty string"),
        );
        return;
      }
      if (Object.hasOwn(message, "id")) this.dispatchServerRequest(message);
      else this.dispatchNotification(message.method, message.params);
      return;
    }
    this.dispatchResponse(message);
  }

  private dispatchResponse(message: Record<string, unknown>): void {
    if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
      if (this.pendingRequests.size > 0)
        this.failClient(
          protocolError("JSON-RPC response has an invalid request ID"),
        );
      return;
    }
    const pending = this.pendingRequests.get(message.id);
    if (pending === undefined) return;
    this.pendingRequests.delete(message.id);
    pending.removeAbortListener();

    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (hasResult === hasError) {
      pending.reject(
        protocolError(
          `Malformed JSON-RPC response for ${pending.method}: expected one result or error`,
        ),
      );
      return;
    }
    if (hasError) {
      pending.reject(parseRemoteError(message.error, pending.method));
      return;
    }
    if (!isJsonRpcValue(message.result)) {
      pending.reject(
        protocolError(`Malformed JSON-RPC result for ${pending.method}`),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private dispatchNotification(method: string, params: unknown): void {
    if (method === "turn/completed") {
      const completed = parseTurnCompleted(params);
      if (completed === undefined) {
        this.failClient(protocolError("Malformed turn/completed notification"));
      } else {
        this.completeTurn(completed);
      }
    }

    const listeners = this.notificationListeners.get(method);
    if (listeners === undefined) return;
    const notification: CodexJsonRpcNotification = {
      method,
      ...(isJsonRpcValue(params) ? { params } : {}),
    };
    for (const listener of listeners) {
      try {
        listener(notification);
      } catch (error) {
        this.failClient(
          new CodexJsonRpcClientError(
            "protocol_error",
            `Codex JSON-RPC notification handler failed for ${method}`,
            { cause: error },
          ),
        );
        break;
      }
    }
  }

  private dispatchServerRequest(message: Record<string, unknown>): void {
    if (
      (typeof message.id !== "string" && typeof message.id !== "number") ||
      (typeof message.id === "string" && message.id.length === 0) ||
      (typeof message.id === "number" && !Number.isSafeInteger(message.id)) ||
      (message.params !== undefined && !isJsonRpcValue(message.params))
    ) {
      this.failClient(
        protocolError("Malformed server-initiated JSON-RPC request"),
      );
      return;
    }
    const request: CodexJsonRpcServerRequest = {
      id: message.id,
      method: message.method as string,
      ...(message.params === undefined ? {} : { params: message.params }),
    };
    void this.respondToServerRequest(request).catch((error: unknown) => {
      this.failClient(
        normalizeClientError(
          error,
          "Could not answer server-initiated JSON-RPC request",
        ),
      );
    });
  }

  private async respondToServerRequest(
    request: CodexJsonRpcServerRequest,
  ): Promise<void> {
    if (this.handleServerRequest === undefined) {
      await this.writeMessage({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32601,
          message: `Unsupported server request: ${request.method}`,
        },
      });
      return;
    }
    try {
      const result = await this.handleServerRequest(request);
      if (!isJsonRpcValue(result))
        throw new TypeError("Server request handler returned a non-JSON value");
      await this.writeMessage({ jsonrpc: "2.0", id: request.id, result });
    } catch {
      try {
        await this.writeMessage({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: "Server request handling failed" },
        });
      } catch (writeError) {
        this.failClient(
          normalizeClientError(
            writeError,
            "Could not answer server-initiated JSON-RPC request",
          ),
        );
      }
    }
  }

  private completeTurn(notification: CodexTurnCompletedNotification): void {
    const key = turnKey(notification.threadId, notification.turn.id);
    const waiters = this.turnWaiters.get(key);
    if (waiters === undefined) {
      this.bufferedTurnCompletions.set(key, notification);
      if (this.bufferedTurnCompletions.size > maximumBufferedTurnCompletions) {
        const oldest = this.bufferedTurnCompletions.keys().next().value;
        if (oldest !== undefined) this.bufferedTurnCompletions.delete(oldest);
      }
      return;
    }
    this.turnWaiters.delete(key);
    for (const waiter of waiters) {
      waiter.removeAbortListener();
      waiter.resolve(notification);
    }
  }

  private finishTransport(): void {
    this.resolveTransportEnded();
    if (this.state !== "closing" && this.state !== "closed")
      this.failClient(
        new CodexJsonRpcClientError(
          "transport_closed",
          "Codex JSON-RPC transport ended unexpectedly",
        ),
      );
  }

  private failClient(error: CodexJsonRpcClientError): void {
    if (this.state === "closing" || this.state === "closed") return;
    this.terminalError = error;
    this.state = "failed";
    this.rejectActiveOperations(error);
  }

  private rejectActiveOperations(error: CodexJsonRpcClientError): void {
    for (const pending of this.pendingRequests.values()) {
      pending.removeAbortListener();
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.rejectTurnWaiters(error);
  }

  private rejectTurnWaiters(error: CodexJsonRpcClientError): void {
    for (const waiters of this.turnWaiters.values()) {
      for (const waiter of waiters) {
        waiter.removeAbortListener();
        waiter.reject(error);
      }
    }
    this.turnWaiters.clear();
  }

  private stateError(): CodexJsonRpcClientError {
    return (
      this.terminalError ??
      new CodexJsonRpcClientError(
        "invalid_state",
        `Codex JSON-RPC client is ${this.state.replace("new", "not initialized")}`,
      )
    );
  }

  private requireApplicationMethod(method: string): void {
    requireMethod(method);
    if (method === "initialize" || method === "initialized")
      throw new CodexJsonRpcClientError(
        "invalid_state",
        `${method} is reserved for the JSON-RPC handshake`,
      );
  }
}

function requireMethod(method: string): void {
  if (method.length === 0)
    throw new TypeError("JSON-RPC method must be non-empty");
}

function installAbortListener(
  signal: AbortSignal | undefined,
  listener: () => void,
): () => void {
  if (signal === undefined) return () => {};
  signal.addEventListener("abort", listener, { once: true });
  return () => signal.removeEventListener("abort", listener);
}

function waitWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolve, reject) => {
    const removeAbortListener = installAbortListener(signal, () => {
      reject(abortError(signal.reason));
    });
    void promise.then(
      (value) => {
        removeAbortListener();
        resolve(value);
      },
      (error: unknown) => {
        removeAbortListener();
        reject(
          error instanceof Error
            ? error
            : new Error("Initialization failed", { cause: error }),
        );
      },
    );
  });
}

function abortError(reason: unknown): CodexJsonRpcClientError {
  return new CodexJsonRpcClientError(
    "aborted",
    "Codex JSON-RPC operation aborted",
    {
      cause: reason,
    },
  );
}

function protocolError(message: string): CodexJsonRpcClientError {
  return new CodexJsonRpcClientError("protocol_error", message);
}

function transportError(
  message: string,
  cause: unknown,
): CodexJsonRpcClientError {
  return new CodexJsonRpcClientError("transport_closed", message, { cause });
}

function normalizeClientError(
  error: unknown,
  message: string,
): CodexJsonRpcClientError {
  return error instanceof CodexJsonRpcClientError
    ? error
    : transportError(message, error);
}

function parseRemoteError(
  value: unknown,
  method: string,
): CodexJsonRpcClientError {
  if (
    !isRecord(value) ||
    typeof value.code !== "number" ||
    !Number.isSafeInteger(value.code) ||
    typeof value.message !== "string" ||
    (value.data !== undefined && !isJsonRpcValue(value.data))
  )
    return protocolError(`Malformed JSON-RPC error response for ${method}`);
  return new CodexJsonRpcRemoteError(value.code, value.message, value.data);
}

function parseTurnCompleted(
  value: unknown,
): CodexTurnCompletedNotification | undefined {
  if (
    !isRecord(value) ||
    typeof value.threadId !== "string" ||
    value.threadId.length === 0 ||
    !isRecord(value.turn) ||
    typeof value.turn.id !== "string" ||
    value.turn.id.length === 0 ||
    !isJsonRpcValue(value)
  )
    return;
  return value as CodexTurnCompletedNotification;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId.length}:${threadId}${turnId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcValue(value: unknown): value is CodexJsonRpcValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonRpcValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonRpcValue);
}
