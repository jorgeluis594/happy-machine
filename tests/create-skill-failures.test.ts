import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

import {
  createProcessEntryPoint,
  type ProcessSignalSource,
} from "../src/composition-root.js";
import type { CodexSpawn } from "../src/infrastructure/outbound/agent-sessions/codex-app-server/codex-process-runtime.js";

const fakeCodex = path.resolve("tests/fixtures/fake-codex.mjs");
const lockFilename = "happy-machine-create-skill.lock";
const workspacePrefix = "happy-machine-create-skill-";
const userId = process.getuid?.();
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

interface HarnessOptions {
  root?: string;
  config?: Record<string, unknown>;
  workflowDescription?: string;
  processId?: number;
  processIsAlive?: (processId: number) => boolean;
  codexSpawnProcess?: CodexSpawn;
}

async function createHarness(options: HarnessOptions = {}) {
  const root =
    options.root ??
    (await mkdtemp(path.join(os.tmpdir(), "create-skill-failures-")));
  temporaryDirectories.add(root);
  const captureRoot = path.join(root, "capture");
  const projectRoot = path.join(root, "project");
  await Promise.all([
    mkdir(captureRoot, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
  ]);
  const logPath = path.join(root, `fake-codex-${randomUUID()}.jsonl`);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const answers = [
    options.workflowDescription ?? "Investigate a production bug",
    "y",
  ];
  const signals = new TestSignalSource();
  const entryPoint = createProcessEntryPoint({
    codexExecutable: fakeCodex,
    codexSpawnProcess: options.codexSpawnProcess,
    codexUpgradeControlTransport: (transport) => Promise.resolve(transport),
    environment: {
      ...process.env,
      FAKE_CODEX_LOG: logPath,
      FAKE_CODEX_CONFIG: JSON.stringify(options.config ?? {}),
    },
    temporaryDirectory: captureRoot,
    processId: options.processId,
    userId,
    processIsAlive: options.processIsAlive,
    streams: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
    createSkillTerminal: {
      isStdinInteractive: () => true,
      isStdoutInteractive: () => true,
      question: () => Promise.resolve(answers.shift() ?? ""),
    },
    signalSource: signals,
  });

  return {
    captureRoot,
    logPath,
    projectRoot,
    root,
    run: () => entryPoint(["create-skill", "--agent=codex"], projectRoot),
    signals,
    stderr,
    stdout,
  };
}

class TestSignalSource implements ProcessSignalSource {
  private readonly listeners = new Map<"SIGINT" | "SIGHUP", Set<() => void>>();

  once(signal: "SIGINT" | "SIGHUP", listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: "SIGINT" | "SIGHUP", listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: "SIGINT" | "SIGHUP"): void {
    const listeners = [...(this.listeners.get(signal) ?? [])];
    this.listeners.delete(signal);
    for (const listener of listeners) listener();
  }
}

describe.runIf(userId !== undefined)("create-skill terminal paths", () => {
  it("contains a runtime-startup protocol failure and cleans every owned resource", async () => {
    const sensitiveVendorMessage = "runtime-secret-must-not-leak";
    const harness = await createHarness({
      config: {
        jsonRpcErrors: {
          initialize: { code: -32001, message: sensitiveVendorMessage },
        },
      },
    });

    await expect(harness.run()).resolves.toBe(1);

    expect(harness.stdout).toEqual([]);
    expect(harness.stderr.join("\n")).toContain("agent_runtime_incompatible");
    expect(harness.stderr.join("\n")).toContain("cleanup completed");
    expect(harness.stderr.join("\n")).toContain("Start a new run");
    expect(harness.stderr.join("\n")).not.toContain(sensitiveVendorMessage);
    expect(
      eventsNamed(await readCallLog(harness.logPath), "tui_started"),
    ).toHaveLength(0);
    await expect(readdir(harness.captureRoot)).resolves.toEqual([]);
  });

  it.each([
    {
      label: "demonstration",
      config: {
        lifecycle: { demonstration: { exit: "nonzero", code: 23 } },
      },
      code: "demonstration_failed",
    },
    {
      label: "analysis",
      config: {
        jsonRpcErrors: {
          "turn/start": { code: -32002, message: "configured turn failure" },
        },
      },
      code: "analysis_failed",
    },
  ])(
    "stops before generation after a $label failure and completes cleanup",
    async ({ config, code }) => {
      const harness = await createHarness({ config });

      await expect(harness.run()).resolves.toBe(1);

      const log = await readCallLog(harness.logPath);
      expect(harness.stderr.join("\n")).toContain(`[${code}]`);
      expect(harness.stderr.join("\n")).toContain("cleanup completed");
      expect(harness.stderr.join("\n")).toContain("Start a new run");
      expect(
        eventsNamed(log, "tui_started").some(
          (event) => event.role === "generation",
        ),
      ).toBe(false);
      expectRuntimeShutdown(log);
      await expect(readdir(harness.captureRoot)).resolves.toEqual([]);
    },
  );

  it.each([
    {
      label: "demonstration",
      signal: "SIGINT" as const,
      config: { lifecycle: { demonstration: { exit: "wait" } } },
      ready: (event: Record<string, unknown>) =>
        event.event === "tui_started" && event.role === "demonstration",
    },
    {
      label: "analysis",
      signal: "SIGHUP" as const,
      config: { analysisWait: true },
      ready: (event: Record<string, unknown>) =>
        isProtocolRequest(event, "turn/start"),
    },
    {
      label: "generation",
      signal: "SIGINT" as const,
      config: { lifecycle: { generation: { exit: "wait" } } },
      ready: (event: Record<string, unknown>) =>
        event.event === "tui_started" && event.role === "generation",
    },
  ])(
    "handles a $signal-equivalent abort during $label without resumable state",
    async ({ config, label, ready, signal }) => {
      const harness = await createHarness({ config });
      const running = harness.run();
      try {
        await waitForLog(harness.logPath, ready);
      } finally {
        harness.signals.emit(signal);
      }

      await expect(running).resolves.toBe(2);

      const log = await readCallLog(harness.logPath);
      expect(harness.stderr).toEqual([]);
      expect(harness.stdout.join("\n")).toContain(`canceled during ${label}`);
      expect(harness.stdout.join("\n")).toContain("cleanup completed");
      expect(harness.stdout.join("\n")).toContain("Start a new run");
      expect(
        eventsNamed(log, "tui_started").some(
          (event) => event.role === "generation",
        ),
      ).toBe(label === "generation");
      const deletedThreads = protocolRequests(log, "thread/delete").map(
        (request) => request.params?.threadId,
      );
      expect(deletedThreads).not.toContain("thread-generation");
      if (label === "analysis") {
        expect(protocolRequests(log, "turn/interrupt")).toHaveLength(1);
      }
      await expect(readdir(harness.captureRoot)).resolves.toEqual([]);
    },
  );

  it("cleans up without deleting a vendor thread when the generation TUI cannot be spawned", async () => {
    const spawnWithGenerationFailure = generationSpawnFailure();
    const harness = await createHarness({
      codexSpawnProcess: spawnWithGenerationFailure,
    });

    await expect(harness.run()).resolves.toBe(1);

    const log = await readCallLog(harness.logPath);
    expect(harness.stderr.join("\n")).toContain("generation_start_failed");
    expect(harness.stderr.join("\n")).toContain("cleanup completed");
    expect(
      protocolRequests(log, "thread/delete").map(
        (request) => request.params?.threadId,
      ),
    ).not.toContain("thread-generation");
    expect(
      eventsNamed(log, "tui_started").some(
        (event) => event.role === "generation",
      ),
    ).toBe(false);
    await expect(readdir(harness.captureRoot)).resolves.toEqual([]);
  });

  it("does not attempt configured vendor deletion for an unregistered generation session", async () => {
    const harness = await createHarness({
      codexSpawnProcess: generationSpawnFailure(),
      config: { threadDeleteErrors: ["thread-generation"] },
    });

    await expect(harness.run()).resolves.toBe(1);

    const log = await readCallLog(harness.logPath);
    expect(harness.stderr.join("\n")).toContain(
      "[generation_start_failed] during generation",
    );
    expect(harness.stderr.join("\n")).toContain("cleanup completed");
    expect(
      protocolRequests(log, "thread/delete").map(
        (request) => request.params?.threadId,
      ),
    ).not.toContain("thread-generation");
    expect(
      eventsNamed(log, "tui_started").some(
        (event) => event.role === "generation",
      ),
    ).toBe(false);
    await expect(readdir(harness.captureRoot)).resolves.toEqual([]);
  });

  it("retains the generation thread after a started TUI exits abnormally", async () => {
    const promptSentinel = "generation-prompt-secret";
    const harness = await createHarness({
      workflowDescription: promptSentinel,
      config: {
        lifecycle: { generation: { exit: "nonzero", code: 29 } },
      },
    });

    await expect(harness.run()).resolves.toBe(1);

    const log = await readCallLog(harness.logPath);
    expect(harness.stderr.join("\n")).toContain("generation_start_failed");
    expect(harness.stderr.join("\n")).not.toContain(promptSentinel);
    expect(eventsNamed(log, "tui_started")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "generation",
          threadId: "thread-generation",
        }),
      ]),
    );
    expect(
      protocolRequests(log, "thread/delete").map(
        (request) => request.params?.threadId,
      ),
    ).not.toContain("thread-generation");
    await expect(readdir(harness.captureRoot)).resolves.toEqual([]);
  });

  it("preserves the primary analysis failure and reports a remaining private workspace without leaking capture data", async () => {
    const captureSentinel = "captured-command-tool-secret";
    const workflowSentinel = "workflow-description-secret";
    const harness = await createHarness({
      workflowDescription: workflowSentinel,
      config: {
        captureSentinel,
        corruptCaptureOwnerOnMethod: "turn/start",
        jsonRpcErrors: {
          "turn/start": { code: -32003, message: captureSentinel },
        },
      },
    });

    await expect(harness.run()).resolves.toBe(1);

    const entries = await readdir(harness.captureRoot);
    const workspaceName = entries.find((entry) =>
      entry.startsWith(workspacePrefix),
    );
    expect(workspaceName).toBeDefined();
    const workspacePath = path.join(harness.captureRoot, workspaceName!);
    const presentation = harness.stderr.join("\n");
    expect(presentation).toContain("[analysis_failed] during analysis");
    expect(presentation).toContain("cleanup is incomplete");
    expect(presentation).toContain(
      `Private workspace requiring manual removal: ${workspacePath}`,
    );
    expect(presentation).toContain("Start a new run");
    expect(presentation).not.toContain(captureSentinel);
    expect(presentation).not.toContain(workflowSentinel);
    expect(
      await readFile(path.join(workspacePath, "demonstration.md"), "utf8"),
    ).toContain(captureSentinel);
    await expect(
      lstat(path.join(harness.captureRoot, lockFilename)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prevents generation when raw-artifact removal fails and still attempts both thread disposals", async () => {
    const harness = await createHarness({
      config: {
        replaceDemonstrationWithDirectoryOnMethod: "turn/start",
      },
    });

    await expect(harness.run()).resolves.toBe(1);

    const log = await readCallLog(harness.logPath);
    expect(harness.stderr.join("\n")).toContain("[cleanup_failed]");
    expect(harness.stderr.join("\n")).toContain("cleanup completed");
    expect(
      eventsNamed(log, "tui_started").some(
        (event) => event.role === "generation",
      ),
    ).toBe(false);
    expect(
      new Set(
        protocolRequests(log, "thread/delete").map(
          (request) => request.params?.threadId,
        ),
      ),
    ).toEqual(new Set(["thread-demonstration", "thread-analysis"]));
    expect(eventsNamed(log, "demonstration_artifact_replaced")).toHaveLength(1);
    await expect(readdir(harness.captureRoot)).resolves.toEqual([]);
  });

  it("attempts every independent cleanup action when thread disposal fails", async () => {
    const sensitiveFailure = "thread-delete-secret";
    const harness = await createHarness({
      config: {
        jsonRpcErrors: {
          "thread/delete": { code: -32004, message: sensitiveFailure },
        },
      },
    });

    await expect(harness.run()).resolves.toBe(1);

    const log = await readCallLog(harness.logPath);
    const deleteRequests = protocolRequests(log, "thread/delete");
    expect(deleteRequests.length).toBeGreaterThanOrEqual(4);
    expect(
      new Set(deleteRequests.map((request) => request.params?.threadId)),
    ).toEqual(new Set(["thread-demonstration", "thread-analysis"]));
    expectRuntimeShutdown(log);
    expect(harness.stderr.join("\n")).toContain("cleanup is incomplete");
    expect(harness.stderr.join("\n")).not.toContain(sensitiveFailure);
    await expect(readdir(harness.captureRoot)).resolves.toEqual([]);
    await expect(
      lstat(path.join(harness.captureRoot, lockFilename)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves runtime startup as primary when its own process shutdown leaves residue", async () => {
    const sensitiveFailure = "startup-and-shutdown-secret";
    const harness = await createHarness({
      config: {
        jsonRpcErrors: {
          initialize: { code: -32005, message: sensitiveFailure },
        },
        lifecycle: {
          appServer: { replaceSocketWithFileOnShutdown: true },
        },
      },
    });

    await expect(harness.run()).resolves.toBe(1);

    const remaining = await readdir(harness.captureRoot);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatch(/^hm-cs-.+\.sock$/);
    expect(
      (await lstat(path.join(harness.captureRoot, remaining[0]))).isFile(),
    ).toBe(true);
    expect(harness.stderr.join("\n")).toContain(
      "[agent_runtime_incompatible] during setup",
    );
    expect(harness.stderr.join("\n")).toContain("cleanup is incomplete");
    expect(harness.stderr.join("\n")).not.toContain(sensitiveFailure);
    await expect(
      lstat(path.join(harness.captureRoot, lockFilename)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe.runIf(userId !== undefined)("create-skill abandoned cleanup", () => {
  it("a later invocation removes only fully validated stale lock and workspace owners", async () => {
    const processId = 9_000;
    const stalePid = 8_000;
    const harness = await createHarness({
      processId,
      processIsAlive: (candidate) => candidate === processId,
    });
    const validWorkspace = await createWorkspaceCandidate(
      harness.captureRoot,
      "valid-stale",
      ownerMarker(stalePid),
    );
    const invalidWorkspace = await createWorkspaceCandidate(
      harness.captureRoot,
      "invalid-stale",
      ownerMarker(stalePid),
    );
    await chmod(path.join(invalidWorkspace, ".capture-owner.json"), 0o644);
    const lockPath = path.join(harness.captureRoot, lockFilename);
    await writeFile(lockPath, "not-valid-owner-metadata\n", { mode: 0o600 });

    await expect(harness.run()).resolves.toBe(1);

    expect(await readFile(lockPath, "utf8")).toBe("not-valid-owner-metadata\n");
    await expect(lstat(validWorkspace)).resolves.toBeDefined();
    await expect(lstat(invalidWorkspace)).resolves.toBeDefined();

    await rm(lockPath);
    await writeFile(
      lockPath,
      `${JSON.stringify(lockOwner(stalePid, "stale-lease"))}\n`,
      { mode: 0o600 },
    );
    await chmod(lockPath, 0o600);
    const secondRun = await createHarness({
      root: harness.root,
      processId,
      processIsAlive: (candidate) => candidate === processId,
    });

    await expect(secondRun.run()).resolves.toBe(0);

    await expect(lstat(validWorkspace)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(invalidWorkspace)).resolves.toBeDefined();
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(harness.captureRoot)).toEqual([
      path.basename(invalidWorkspace),
    ]);
    expect(secondRun.stdout.join("\n")).not.toContain(invalidWorkspace);
  });
});

interface ProtocolRequest {
  method?: string;
  params?: Record<string, unknown>;
}

async function readCallLog(
  logPath: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    return (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function waitForLog(
  logPath: string,
  predicate: (event: Record<string, unknown>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await readCallLog(logPath)).some(predicate)) return;
    await wait(10);
  }
  throw new Error(`Timed out waiting for fake Codex event in ${logPath}`);
}

function eventsNamed(
  log: readonly Record<string, unknown>[],
  eventName: string,
): Array<Record<string, unknown>> {
  return log.filter((event) => event.event === eventName);
}

function protocolRequests(
  log: readonly Record<string, unknown>[],
  method: string,
): ProtocolRequest[] {
  return log.flatMap((event) =>
    isProtocolRequest(event, method) ? [event.message as ProtocolRequest] : [],
  );
}

function isProtocolRequest(
  event: Record<string, unknown>,
  method: string,
): boolean {
  return (
    event.event === "protocol_in" &&
    typeof event.message === "object" &&
    event.message !== null &&
    (event.message as ProtocolRequest).method === method
  );
}

function expectRuntimeShutdown(log: readonly Record<string, unknown>[]): void {
  expect(eventsNamed(log, "stdin_closed")).toEqual(
    expect.arrayContaining([expect.objectContaining({ role: "proxy" })]),
  );
  expect(eventsNamed(log, "shutdown_requested")).toEqual(
    expect.arrayContaining([expect.objectContaining({ role: "appServer" })]),
  );
}

function generationSpawnFailure(): CodexSpawn {
  return (executable, args, options) =>
    args[0] === "--remote" && args.length === 3
      ? spawn(path.join(os.tmpdir(), "missing-fake-codex"), [...args], options)
      : spawn(executable, [...args], options);
}

async function createWorkspaceCandidate(
  root: string,
  suffix: string,
  marker: unknown,
): Promise<string> {
  const workspace = path.join(root, `${workspacePrefix}${suffix}`);
  await mkdir(workspace, { mode: 0o700 });
  await chmod(workspace, 0o700);
  await writeFile(
    path.join(workspace, ".capture-owner.json"),
    `${JSON.stringify(marker)}\n`,
    { mode: 0o600 },
  );
  await chmod(path.join(workspace, ".capture-owner.json"), 0o600);
  return workspace;
}

function ownerMarker(pid: number) {
  return {
    formatVersion: 1,
    pid,
    createdAt: "2026-08-21T12:34:56.000Z",
  };
}

function lockOwner(pid: number, leaseId: string) {
  return {
    formatVersion: 1,
    operation: "create-skill",
    leaseId,
    pid,
    createdAt: "2026-08-21T12:34:56.000Z",
  };
}
