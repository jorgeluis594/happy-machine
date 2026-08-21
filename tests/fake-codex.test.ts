import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const fixture = path.resolve("tests/fixtures/fake-codex.mjs");
const children = new Set<ChildProcess>();
const temporaryDirectories = new Set<string>();

interface FixtureConfig {
  eventOrder?:
    "notifications-first" | "response-first" | "reverse-notifications";
  interleavedNotifications?: boolean;
  emptyConversation?: boolean;
  invalidAnalysis?: boolean;
  malformedJsonMethods?: string[];
  jsonRpcErrors?: Record<string, { code?: number; message?: string }>;
  lifecycle?: Record<
    string,
    {
      exit?: "normal" | "nonzero" | "signal" | "wait";
      code?: number;
      signal?: NodeJS.Signals;
      shutdownDelayMs?: number;
    }
  >;
}

interface FixtureRun {
  child: ChildProcess;
  logPath: string;
  root: string;
}

async function startFixture(
  args: string[],
  config: FixtureConfig = {},
): Promise<FixtureRun> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-fake-codex-"));
  temporaryDirectories.add(root);
  const logPath = path.join(root, "calls.jsonl");
  const child = spawn(process.execPath, [fixture, ...args], {
    cwd: root,
    env: {
      ...process.env,
      FAKE_CODEX_CONFIG: JSON.stringify(config),
      FAKE_CODEX_LOG: logPath,
    },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  return { child, logPath, root };
}

function waitForReady(child: ChildProcess, role: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === role
      ) {
        cleanup();
        resolve();
      }
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `fake Codex closed before ready: ${String(code)} ${String(signal)}`,
        ),
      );
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("close", onClose);
    };
    child.on("message", onMessage);
    child.on("close", onClose);
  });
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function jsonLines(child: ChildProcess): {
  next: () => Promise<unknown>;
} {
  if (!child.stdout) throw new Error("fixture stdout was not piped");
  const lines = readline.createInterface({ input: child.stdout });
  const queued: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  lines.on("line", (line) => {
    const value = JSON.parse(line) as unknown;
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queued.push(value);
  });
  return {
    next: () => {
      const value = queued.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function rawLines(child: ChildProcess): {
  next: () => Promise<string>;
} {
  if (!child.stdout) throw new Error("fixture stdout was not piped");
  const lines = readline.createInterface({ input: child.stdout });
  const queued: string[] = [];
  const waiters: Array<(value: string) => void> = [];
  lines.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queued.push(line);
  });
  return {
    next: () => {
      const value = queued.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function callLog(logPath: string): Promise<Record<string, unknown>[]> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...children].map((child) => waitForExit(child)));
  children.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe("fake Codex executable", () => {
  it("drives distinct session roles and correlatable reordered protocol events", async () => {
    const run = await startFixture(
      ["app-server", "proxy", "--sock", "/tmp/fake-codex.sock"],
      { eventOrder: "notifications-first", interleavedNotifications: true },
    );
    await waitForReady(run.child, "proxy");
    const output = jsonLines(run.child);
    const send = (message: unknown) => {
      run.child.stdin?.write(`${JSON.stringify(message)}\n`);
    };

    send({ jsonrpc: "2.0", id: "request-initialize", method: "initialize" });
    expect(await output.next()).toMatchObject({ id: "request-initialize" });
    send({ jsonrpc: "2.0", method: "initialized" });

    const threadIds: string[] = [];
    for (const requestId of [
      "request-demonstration",
      "request-analysis",
      "request-generation",
    ]) {
      send({
        jsonrpc: "2.0",
        id: requestId,
        method: "thread/start",
        params: {},
      });
      expect(await output.next()).toMatchObject({ method: "thread/started" });
      expect(await output.next()).toMatchObject({ method: "account/updated" });
      const response = (await output.next()) as {
        id: string;
        result: { thread: { id: string } };
      };
      expect(response.id).toBe(requestId);
      threadIds.push(response.result.thread.id);
    }

    expect(threadIds).toEqual([
      "thread-demonstration",
      "thread-analysis",
      "thread-generation",
    ]);
    expect(new Set(threadIds).size).toBe(3);

    send({
      jsonrpc: "2.0",
      id: "request-turn-analysis",
      method: "turn/start",
      params: {
        threadId: threadIds[1],
        input: [{ type: "text", text: "analyze" }],
      },
    });
    const turnEvents = await Promise.all(
      Array.from({ length: 6 }, () => output.next()),
    );
    const turnStarted = turnEvents.find(
      (event) => (event as { method?: string }).method === "turn/started",
    ) as { params: { turn: { id: string } } };
    const itemCompleted = turnEvents.find(
      (event) => (event as { method?: string }).method === "item/completed",
    ) as { params: { turnId: string; item: { id: string } } };
    const turnCompleted = turnEvents.find(
      (event) => (event as { method?: string }).method === "turn/completed",
    ) as { params: { turn: { id: string } } };
    expect(turnStarted.params.turn.id).toBe(
      "turn-analysis-for-thread-analysis",
    );
    expect(turnCompleted.params.turn.id).toBe(turnStarted.params.turn.id);
    expect(itemCompleted.params.turnId).toBe(turnStarted.params.turn.id);
    expect(itemCompleted.params.item.id).toBe(
      "item-analysis-for-thread-analysis",
    );
    expect(itemCompleted.params.item.id).not.toBe(turnStarted.params.turn.id);

    send({
      jsonrpc: "2.0",
      id: "request-read-demonstration",
      method: "thread/read",
      params: { threadId: threadIds[0], includeTurns: true },
    });
    const readResponse = (await output.next()) as {
      result: { thread: { turns: Array<{ id: string; items: unknown[] }> } };
    };
    expect(readResponse.result.thread.turns[0]?.id).toBe(
      "turn-demonstration-for-thread-demonstration",
    );
    expect(readResponse.result.thread.turns[0]?.items).toHaveLength(6);

    run.child.stdin?.end();
    await expect(waitForExit(run.child)).resolves.toEqual({
      code: 0,
      signal: null,
    });
    const log = await callLog(run.logPath);
    expect(log).toContainEqual(
      expect.objectContaining({
        event: "spawn",
        args: ["app-server", "proxy", "--sock", "/tmp/fake-codex.sock"],
      }),
    );
    expect(log.filter((entry) => entry.event === "protocol_in")).toHaveLength(
      7,
    );
  });

  it("selects protocol failures explicitly and preserves them in the call log", async () => {
    const run = await startFixture(
      ["app-server", "proxy", "--sock", "/tmp/fake-codex.sock"],
      {
        emptyConversation: true,
        invalidAnalysis: true,
        malformedJsonMethods: ["thread/delete"],
        jsonRpcErrors: {
          "turn/interrupt": {
            code: -32044,
            message: "configured interruption error",
          },
        },
      },
    );
    await waitForReady(run.child, "proxy");
    const output = rawLines(run.child);
    const send = (message: unknown) =>
      run.child.stdin?.write(`${JSON.stringify(message)}\n`);

    send({
      jsonrpc: "2.0",
      id: "request-empty",
      method: "thread/read",
      params: { threadId: "thread-demonstration", includeTurns: true },
    });
    expect(JSON.parse(await output.next())).toMatchObject({
      id: "request-empty",
      result: { thread: { turns: [] } },
    });
    send({
      jsonrpc: "2.0",
      id: "request-invalid-analysis",
      method: "turn/start",
      params: { threadId: "thread-analysis" },
    });
    const turnResponse = JSON.parse(await output.next()) as { id: string };
    expect(turnResponse.id).toBe("request-invalid-analysis");
    const notifications = await Promise.all(
      Array.from(
        { length: 4 },
        async () => JSON.parse(await output.next()) as unknown,
      ),
    );
    const itemCompleted = notifications.find(
      (notification) =>
        typeof notification === "object" &&
        notification !== null &&
        "method" in notification &&
        notification.method === "item/completed",
    ) as { params: { item: { text: string } } } | undefined;
    expect(itemCompleted?.params.item.text).toBe('{"markdown":"   "}');
    send({
      jsonrpc: "2.0",
      id: "request-rpc-error",
      method: "turn/interrupt",
      params: { threadId: "thread-analysis", turnId: "turn-analysis" },
    });
    expect(JSON.parse(await output.next())).toEqual({
      jsonrpc: "2.0",
      id: "request-rpc-error",
      error: { code: -32044, message: "configured interruption error" },
    });
    send({
      jsonrpc: "2.0",
      id: "request-malformed",
      method: "thread/delete",
      params: { threadId: "thread-demonstration" },
    });
    expect(await output.next()).toBe("{malformed-json");

    run.child.stdin?.end();
    await waitForExit(run.child);
    const log = await callLog(run.logPath);
    expect(log).toContainEqual(
      expect.objectContaining({
        event: "protocol_out_malformed",
        method: "thread/delete",
      }),
    );
    expect(
      log.some(
        (entry) =>
          entry.event === "protocol_in" &&
          typeof entry.message === "object" &&
          entry.message !== null &&
          "id" in entry.message &&
          entry.message.id === "request-rpc-error",
      ),
    ).toBe(true);
  });

  it.each([
    ["normal", {}, { code: 0, signal: null }],
    ["non-zero", { exit: "nonzero", code: 23 }, { code: 23, signal: null }],
    [
      "signal",
      { exit: "signal", signal: "SIGTERM" },
      { code: null, signal: "SIGTERM" },
    ],
  ] as const)("models a %s TUI exit", async (_label, lifecycle, expected) => {
    const run = await startFixture(["--remote", "unix:///tmp/fake.sock"], {
      lifecycle: { demonstration: lifecycle },
    });
    await expect(waitForExit(run.child)).resolves.toEqual(expected);
    const log = await callLog(run.logPath);
    expect(log).toContainEqual(
      expect.objectContaining({
        event: "tui_started",
        role: "demonstration",
        threadId: "thread-demonstration",
      }),
    );
  });

  it("records a generation prompt and delays process shutdown deterministically", async () => {
    const run = await startFixture(
      [
        "--remote",
        "unix:///tmp/fake.sock",
        "Create the reusable skill from /tmp/skill-context.md",
      ],
      {
        lifecycle: {
          generation: { exit: "wait", shutdownDelayMs: 15 },
        },
      },
    );
    await waitForReady(run.child, "generation");
    run.child.kill("SIGTERM");
    await expect(waitForExit(run.child)).resolves.toEqual({
      code: 0,
      signal: null,
    });
    const log = await callLog(run.logPath);
    expect(log).toContainEqual(
      expect.objectContaining({
        event: "tui_started",
        role: "generation",
        initialPrompt: "Create the reusable skill from /tmp/skill-context.md",
      }),
    );
    expect(log).toContainEqual(
      expect.objectContaining({
        event: "shutdown_requested",
        role: "generation",
        delayMs: 15,
      }),
    );
    expect(log.at(-1)).toEqual({
      event: "shutdown_completed",
      role: "generation",
    });
  });

  it("creates and removes the app-server socket around a controlled lifecycle", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "happy-fake-codex-socket-"),
    );
    temporaryDirectories.add(root);
    const socketPath = path.join(root, "app-server.sock");
    const run = await startFixture(
      ["app-server", "--listen", `unix://${socketPath}`],
      { lifecycle: { appServer: { shutdownDelayMs: 10 } } },
    );
    await waitForReady(run.child, "appServer");
    run.child.kill("SIGTERM");
    await expect(waitForExit(run.child)).resolves.toEqual({
      code: 0,
      signal: null,
    });
    const log = await callLog(run.logPath);
    expect(log).toContainEqual(
      expect.objectContaining({
        event: "ready",
        role: "appServer",
        socketPath,
      }),
    );
    await expect(readFile(socketPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
