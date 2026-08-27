import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexJsonRpcClient,
  CodexJsonRpcRemoteError,
  CodexJsonRpcShutdownTimeoutError,
  type CodexJsonRpcValue,
} from "../src/infrastructure/outbound/agent-sessions/codex-app-server/codex-json-rpc-client.js";

interface SentMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: CodexJsonRpcValue;
  result?: CodexJsonRpcValue;
  error?: CodexJsonRpcValue;
}

class DeterministicJsonlTransport {
  readonly readable = new PassThrough();
  readonly writable = new PassThrough();
  private readonly sent: SentMessage[] = [];
  private readonly sentWaiters: Array<(message: SentMessage) => void> = [];
  private outgoingBuffer = "";

  constructor() {
    this.writable.setEncoding("utf8");
    this.writable.on("data", (chunk: string) => {
      this.outgoingBuffer += chunk;
      while (true) {
        const newline = this.outgoingBuffer.indexOf("\n");
        if (newline < 0) return;
        const line = this.outgoingBuffer.slice(0, newline);
        this.outgoingBuffer = this.outgoingBuffer.slice(newline + 1);
        const message = JSON.parse(line) as SentMessage;
        const waiter = this.sentWaiters.shift();
        if (waiter) waiter(message);
        else this.sent.push(message);
      }
    });
  }

  nextSent(): Promise<SentMessage> {
    const message = this.sent.shift();
    if (message !== undefined) return Promise.resolve(message);
    return new Promise((resolve) => this.sentWaiters.push(resolve));
  }

  receive(message: unknown): void {
    this.readable.write(`${JSON.stringify(message)}\n`);
  }

  receiveRaw(line: string): void {
    this.readable.write(`${line}\n`);
  }

  endInput(): void {
    this.readable.end();
  }
}

async function initialize(
  client: CodexJsonRpcClient,
  transport: DeterministicJsonlTransport,
): Promise<void> {
  const initializing = client.initialize({
    clientInfo: { name: "happy-machine", version: "0.0.0" },
  });
  const request = await transport.nextSent();
  expect(request).toMatchObject({ id: 1, method: "initialize" });
  transport.receive({ jsonrpc: "2.0", id: request.id, result: {} });
  await expect(transport.nextSent()).resolves.toMatchObject({
    method: "initialized",
  });
  await initializing;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CodexJsonRpcClient", () => {
  it("finishes initialize before sending any queued request", async () => {
    const transport = new DeterministicJsonlTransport();
    const client = new CodexJsonRpcClient(transport);

    const initializing = client.initialize({
      clientInfo: { name: "happy-machine", version: "0.0.0" },
    });
    const queued = client.request("thread/read", { threadId: "thread-1" });
    const abort = new AbortController();
    const canceledWhileQueued = client.request(
      "thread/read",
      { threadId: "never-sent" },
      { signal: abort.signal },
    );
    abort.abort("canceled during handshake");
    await expect(canceledWhileQueued).rejects.toMatchObject({
      code: "aborted",
    });
    const initializeRequest = await transport.nextSent();
    expect(initializeRequest).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "happy-machine", version: "0.0.0" },
      },
    });

    transport.receive({ id: 1, result: { capabilities: {} } });
    expect(await transport.nextSent()).toEqual({
      jsonrpc: "2.0",
      method: "initialized",
      params: {},
    });
    const applicationRequest = await transport.nextSent();
    expect(applicationRequest).toMatchObject({
      id: 2,
      method: "thread/read",
    });
    transport.receive({ id: 2, result: { thread: { id: "thread-1" } } });

    await expect(initializing).resolves.toEqual({ capabilities: {} });
    await expect(queued).resolves.toEqual({ thread: { id: "thread-1" } });
  });

  it("correlates reordered responses across interleaved notifications", async () => {
    const transport = new DeterministicJsonlTransport();
    const client = new CodexJsonRpcClient(transport);
    await initialize(client, transport);
    const notifications: string[] = [];
    client.onNotification("account/updated", (notification) => {
      notifications.push(notification.method);
    });

    const first = client.request("thread/read", { threadId: "thread-1" });
    const second = client.request("thread/read", { threadId: "thread-2" });
    const firstRequest = await transport.nextSent();
    const secondRequest = await transport.nextSent();
    transport.receive({
      jsonrpc: "2.0",
      method: "account/updated",
      params: { accountId: "unrelated" },
    });
    transport.receive({ id: secondRequest.id, result: { value: "second" } });
    transport.receive({ id: firstRequest.id, result: { value: "first" } });

    await expect(first).resolves.toEqual({ value: "first" });
    await expect(second).resolves.toEqual({ value: "second" });
    expect(firstRequest.id).toBe(2);
    expect(secondRequest.id).toBe(3);
    expect(notifications).toEqual(["account/updated"]);
  });

  it("matches turn completion by both thread and turn and buffers early events", async () => {
    const transport = new DeterministicJsonlTransport();
    const client = new CodexJsonRpcClient(transport);
    await initialize(client, transport);

    let completed = false;
    const waiting = client
      .waitForTurnCompletion("thread-analysis", "turn-analysis")
      .then((result) => {
        completed = true;
        return result;
      });
    transport.receive({
      method: "turn/completed",
      params: {
        threadId: "thread-other",
        turn: { id: "turn-analysis", status: "completed" },
      },
    });
    transport.receive({
      method: "turn/completed",
      params: {
        threadId: "thread-analysis",
        turn: { id: "turn-other", status: "completed" },
      },
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    transport.receive({
      method: "turn/completed",
      params: {
        threadId: "thread-analysis",
        turn: { id: "turn-analysis", status: "completed" },
      },
    });
    await expect(waiting).resolves.toMatchObject({
      threadId: "thread-analysis",
      turn: { id: "turn-analysis" },
    });

    transport.receive({
      method: "turn/completed",
      params: {
        threadId: "thread-early",
        turn: { id: "turn-early", status: "completed" },
      },
    });
    await expect(
      client.waitForTurnCompletion("thread-early", "turn-early"),
    ).resolves.toMatchObject({ threadId: "thread-early" });
  });

  it("answers server-initiated requests with their original IDs", async () => {
    const transport = new DeterministicJsonlTransport();
    const requests: string[] = [];
    const client = new CodexJsonRpcClient({
      ...transport,
      handleServerRequest: (request) => {
        requests.push(request.method);
        return { decision: "decline" };
      },
    });
    await initialize(client, transport);

    transport.receive({
      jsonrpc: "2.0",
      id: "approval-7",
      method: "item/commandExecution/requestApproval",
    });

    await expect(transport.nextSent()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "approval-7",
      result: { decision: "decline" },
    });
    expect(requests).toEqual(["item/commandExecution/requestApproval"]);
  });

  it("rejects malformed required responses and JSON-RPC errors", async () => {
    const malformedTransport = new DeterministicJsonlTransport();
    const malformedClient = new CodexJsonRpcClient(malformedTransport);
    await initialize(malformedClient, malformedTransport);
    const malformed = malformedClient.request("thread/read");
    const malformedRequest = await malformedTransport.nextSent();
    malformedTransport.receive({ id: malformedRequest.id, unexpected: true });
    await expect(malformed).rejects.toMatchObject({
      name: "CodexJsonRpcClientError",
      code: "protocol_error",
    });

    const errorTransport = new DeterministicJsonlTransport();
    const errorClient = new CodexJsonRpcClient(errorTransport);
    await initialize(errorClient, errorTransport);
    const failed = errorClient.request("turn/start");
    const failedRequest = await errorTransport.nextSent();
    errorTransport.receive({
      id: failedRequest.id,
      error: {
        code: -32044,
        message: "configured failure",
        data: { safe: true },
      },
    });
    await expect(failed).rejects.toBeInstanceOf(CodexJsonRpcRemoteError);
    await expect(failed).rejects.toMatchObject({
      name: "CodexJsonRpcRemoteError",
      code: "remote_error",
      remoteCode: -32044,
      message: "configured failure",
    });
  });

  it("rejects every unresolved operation on malformed JSON or unexpected EOF", async () => {
    const malformedTransport = new DeterministicJsonlTransport();
    const malformedClient = new CodexJsonRpcClient(malformedTransport);
    await initialize(malformedClient, malformedTransport);
    const malformed = malformedClient.request("thread/read");
    await malformedTransport.nextSent();
    malformedTransport.receiveRaw("{malformed-json");
    await expect(malformed).rejects.toMatchObject({ code: "protocol_error" });

    const eofTransport = new DeterministicJsonlTransport();
    const eofClient = new CodexJsonRpcClient(eofTransport);
    await initialize(eofClient, eofTransport);
    const request = eofClient.request("thread/read");
    const turn = eofClient.waitForTurnCompletion("thread-1", "turn-1");
    await eofTransport.nextSent();
    eofTransport.endInput();
    await expect(request).rejects.toMatchObject({ code: "transport_closed" });
    await expect(turn).rejects.toMatchObject({ code: "transport_closed" });
  });

  it("removes aborted requests and turn waiters without hanging", async () => {
    const transport = new DeterministicJsonlTransport();
    const client = new CodexJsonRpcClient(transport);
    await initialize(client, transport);

    const requestAbort = new AbortController();
    const request = client.request("thread/read", undefined, {
      signal: requestAbort.signal,
    });
    const outbound = await transport.nextSent();
    requestAbort.abort("request canceled");
    await expect(request).rejects.toMatchObject({ code: "aborted" });
    transport.receive({ id: outbound.id, result: { late: true } });

    const turnAbort = new AbortController();
    const turn = client.waitForTurnCompletion("thread-1", "turn-1", {
      signal: turnAbort.signal,
    });
    turnAbort.abort("turn canceled");
    await expect(turn).rejects.toMatchObject({ code: "aborted" });
  });

  it("retains malformed required notification failures for future waiters", async () => {
    const transport = new DeterministicJsonlTransport();
    const client = new CodexJsonRpcClient(transport);
    await initialize(client, transport);

    transport.receive({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "completed" } },
    });

    await expect(
      client.waitForTurnCompletion("thread-1", "turn-1"),
    ).rejects.toMatchObject({ code: "protocol_error" });
  });

  it("rejects unresolved work while shutting down cleanly", async () => {
    const transport = new DeterministicJsonlTransport();
    const client = new CodexJsonRpcClient(transport);
    await initialize(client, transport);
    const unresolved = client.request("thread/read");
    await transport.nextSent();
    transport.writable.once("finish", () => transport.endInput());

    const shutdown = client.shutdown();

    await expect(unresolved).rejects.toMatchObject({
      code: "transport_closed",
    });
    await expect(shutdown).resolves.toBeUndefined();
  });

  it("bounds shutdown when the transport does not end", async () => {
    vi.useFakeTimers();
    const transport = new DeterministicJsonlTransport();
    const client = new CodexJsonRpcClient({
      ...transport,
      shutdownTimeoutMs: 25,
    });
    const shutdown = client.shutdown();
    const rejection = expect(shutdown).rejects.toBeInstanceOf(
      CodexJsonRpcShutdownTimeoutError,
    );

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
  });

  it("rejects application requests before initialization", async () => {
    const client = new CodexJsonRpcClient(new DeterministicJsonlTransport());
    await expect(client.request("thread/read")).rejects.toMatchObject({
      code: "invalid_state",
    });
  });
});
