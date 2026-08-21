import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexProcessRuntime,
  CodexProcessRuntimeError,
  type CodexProcessRuntimeOptions,
  type CodexSpawn,
} from "../src/infrastructure/outbound/agent-sessions/codex-app-server/codex-process-runtime.js";

const fixture = path.resolve("tests/fixtures/fake-codex.mjs");
const temporaryDirectories = new Set<string>();
const runtimes = new Set<CodexProcessRuntime>();

interface FixtureConfig {
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

interface RuntimeFixture {
  root: string;
  logPath: string;
  socketPath: string;
  runtime: CodexProcessRuntime;
}

async function runtimeFixture(
  config: FixtureConfig = {},
  overrides: Partial<CodexProcessRuntimeOptions> = {},
): Promise<RuntimeFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-codex-runtime-"));
  temporaryDirectories.add(root);
  const logPath = path.join(root, "calls.jsonl");
  const socketPath = path.join(root, "app-server.sock");
  const runtime = new CodexProcessRuntime({
    executable: fixture,
    socketPath,
    currentDirectory: root,
    environment: {
      ...process.env,
      FAKE_CODEX_CONFIG: JSON.stringify(config),
      FAKE_CODEX_LOG: logPath,
    },
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 100,
    ...overrides,
  });
  runtimes.add(runtime);
  return { root, logPath, socketPath, runtime };
}

async function callLog(logPath: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(logPath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForLog(
  logPath: string,
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const event = (await callLog(logPath)).find(predicate);
      if (event) return event;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the fake Codex call log.");
}

afterEach(async () => {
  await Promise.allSettled([...runtimes].map((runtime) => runtime.stop()));
  runtimes.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
  vi.restoreAllMocks();
});

describe("CodexProcessRuntime", () => {
  it("checks every required command form without a shell", async () => {
    const spawnOptions: Parameters<CodexSpawn>[2][] = [];
    const recordingSpawn: CodexSpawn = (executable, args, options) => {
      spawnOptions.push(options);
      return spawn(executable, args, options);
    };
    const run = await runtimeFixture({}, { spawnProcess: recordingSpawn });

    await expect(run.runtime.checkCompatibility()).resolves.toBeUndefined();

    const spawns = (await callLog(run.logPath)).filter(
      (event) => event.event === "spawn",
    );
    expect(spawns.map((event) => event.args)).toEqual([
      ["app-server", "--help"],
      ["app-server", "proxy", "--help"],
      ["resume", "--help"],
    ]);
    expect(spawnOptions).toHaveLength(3);
    expect(spawnOptions.every((options) => options.shell === false)).toBe(true);
  });

  it("reports a missing executable and unsupported argument forms", async () => {
    const missing = await runtimeFixture({}, { executable: "/missing/codex" });
    await expect(missing.runtime.checkCompatibility()).rejects.toMatchObject({
      code: "unavailable",
    });

    const root = await mkdtemp(path.join(os.tmpdir(), "happy-codex-help-"));
    temporaryDirectories.add(root);
    const executable = path.join(root, "codex.mjs");
    await writeFile(
      executable,
      "#!/usr/bin/env node\nprocess.stdout.write('Usage: codex unsupported\\n');\n",
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const unsupported = await runtimeFixture({}, { executable });

    await expect(
      unsupported.runtime.checkCompatibility(),
    ).rejects.toMatchObject({ code: "incompatible" });
  });

  it("starts app-server before the proxy and exposes proxy JSONL streams", async () => {
    const run = await runtimeFixture();

    const transport = await run.runtime.start();
    await waitForLog(
      run.logPath,
      (event) =>
        event.event === "spawn" &&
        Array.isArray(event.args) &&
        event.args[1] === "proxy",
    );

    expect(transport.readable).toBeDefined();
    expect(transport.writable).toBeDefined();
    const spawns = (await callLog(run.logPath)).filter(
      (event) => event.event === "spawn",
    );
    expect(spawns.map((event) => event.args)).toEqual([
      ["app-server", "--listen", `unix://${run.socketPath}`],
      ["app-server", "proxy", "--sock", run.socketPath],
    ]);
    expect(
      (await callLog(run.logPath)).findIndex(
        (event) => event.event === "ready" && event.role === "appServer",
      ),
    ).toBeLessThan(
      (await callLog(run.logPath)).findIndex(
        (event) =>
          event.event === "spawn" &&
          Array.isArray(event.args) &&
          event.args[1] === "proxy",
      ),
    );
  });

  it("removes a stale socket but rejects an unrelated entry at the socket path", async () => {
    const stale = await runtimeFixture();
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(stale.socketPath, resolve);
    });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );

    await expect(stale.runtime.start()).resolves.toBeDefined();
    await stale.runtime.stop();

    const occupied = await runtimeFixture();
    await writeFile(occupied.socketPath, "do not remove", { mode: 0o600 });
    await expect(occupied.runtime.start()).rejects.toMatchObject({
      code: "startup_failed",
    });
    await expect(readFile(occupied.socketPath, "utf8")).resolves.toBe(
      "do not remove",
    );
  });

  it.each([
    [
      "normal",
      { exit: "normal" as const, code: 0 },
      { reason: "normal", exitCode: 0 },
    ],
    [
      "failed",
      { exit: "nonzero" as const, code: 23 },
      { reason: "failed", exitCode: 23 },
    ],
    [
      "interrupted",
      { exit: "signal" as const, signal: "SIGTERM" as const },
      { reason: "interrupted" },
    ],
  ])("maps a %s TUI exit", async (_label, lifecycle, expected) => {
    const run = await runtimeFixture({
      lifecycle: { demonstration: lifecycle },
    });
    await run.runtime.start();

    await expect(
      run.runtime.runTui({
        threadId: "thread-demonstration",
        currentDirectory: run.root,
      }),
    ).resolves.toEqual(expected);
  });

  it("inherits the terminal and passes unsafe workflow text as one literal argument", async () => {
    const spawnCalls: Array<{
      args: readonly string[];
      options: Parameters<CodexSpawn>[2];
    }> = [];
    const recordingSpawn: CodexSpawn = (executable, args, options) => {
      spawnCalls.push({ args, options });
      return spawn(executable, args, options);
    };
    const run = await runtimeFixture({}, { spawnProcess: recordingSpawn });
    await run.runtime.start();
    const prompt =
      "Read /tmp/context file.md; $(touch /tmp/must-not-run) && create the skill";

    await run.runtime.runTui({
      threadId: "thread-generation; echo injected",
      currentDirectory: run.root,
      initialPrompt: prompt,
    });

    const tuiSpawn = spawnCalls.at(-1);
    expect(tuiSpawn?.options).toMatchObject({ shell: false, stdio: "inherit" });
    expect(tuiSpawn?.args).toEqual([
      "resume",
      "--remote",
      `unix://${run.socketPath}`,
      "thread-generation; echo injected",
      prompt,
    ]);
    const tuiLog = (await callLog(run.logPath)).find(
      (event) => event.event === "tui_started",
    );
    expect(tuiLog).toMatchObject({
      threadId: "thread-generation; echo injected",
      initialPrompt: prompt,
    });
  });

  it("aborts an active TUI, waits for it to exit, and classifies interruption", async () => {
    const run = await runtimeFixture({
      lifecycle: { demonstration: { exit: "wait" } },
    });
    await run.runtime.start();
    const abort = new AbortController();
    const tui = run.runtime.runTui({
      threadId: "thread-demonstration",
      currentDirectory: run.root,
      signal: abort.signal,
    });
    await waitForLog(
      run.logPath,
      (event) =>
        event.event === "tui_started" && event.role === "demonstration",
    );

    abort.abort("user canceled");

    await expect(tui).resolves.toEqual({ reason: "interrupted" });
    await expect(
      waitForLog(
        run.logPath,
        (event) =>
          event.event === "shutdown_completed" &&
          event.role === "demonstration",
      ),
    ).resolves.toBeDefined();
  });

  it("stops active TUI, proxy, and app-server in bounded order and reaps them", async () => {
    const run = await runtimeFixture(
      {
        lifecycle: {
          demonstration: { exit: "wait", shutdownDelayMs: 10_000 },
          proxy: { exit: "wait", shutdownDelayMs: 10_000 },
          appServer: { exit: "wait", shutdownDelayMs: 10_000 },
        },
      },
      { shutdownTimeoutMs: 50 },
    );
    await run.runtime.start();
    const tui = run.runtime.runTui({
      threadId: "thread-demonstration",
      currentDirectory: run.root,
    });
    await waitForLog(
      run.logPath,
      (event) =>
        event.event === "tui_started" && event.role === "demonstration",
    );

    const startedAt = Date.now();
    await Promise.all([run.runtime.stop(), run.runtime.stop()]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(tui).resolves.toEqual({ reason: "interrupted" });

    const shutdownRequests = (await callLog(run.logPath)).filter(
      (event) => event.event === "shutdown_requested",
    );
    expect(shutdownRequests.map((event) => event.role)).toEqual([
      "demonstration",
      "proxy",
      "appServer",
    ]);
    await expect(readFile(run.socketPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps prompt content out of process failures while retaining a safe cause", async () => {
    const run = await runtimeFixture();
    await run.runtime.start();
    const secretPrompt = "SECRET-WORKFLOW-CONTENT";
    const spawnError = new Error("spawn failed safely");
    const failingSpawn: CodexSpawn = (_executable, args, options) => {
      if (args[0] === "resume") throw spawnError;
      return spawn(fixture, args, options);
    };
    const isolated = await runtimeFixture({}, { spawnProcess: failingSpawn });
    await isolated.runtime.start();

    let thrown: unknown;
    try {
      await isolated.runtime.runTui({
        threadId: "thread-generation",
        currentDirectory: isolated.root,
        initialPrompt: secretPrompt,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CodexProcessRuntimeError);
    expect((thrown as Error).message).not.toContain(secretPrompt);
    expect((thrown as Error).cause).toBe(spawnError);
    await run.runtime.stop();
  });
});

function isFileSystemError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
