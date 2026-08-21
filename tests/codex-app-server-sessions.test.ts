import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CodexAppServerSessions } from "../src/infrastructure/outbound/agent-sessions/codex-app-server/codex-app-server-sessions.js";
import { CodexProcessRuntime } from "../src/infrastructure/outbound/agent-sessions/codex-app-server/codex-process-runtime.js";
import { AgentRuntimeUnavailableError } from "../src/ports/agent-sessions.js";

const fixture = path.resolve("tests/fixtures/fake-codex.mjs");
const temporaryDirectories = new Set<string>();
const adapters = new Set<CodexAppServerSessions>();

interface FixtureConfig {
  eventOrder?: "notifications-first" | "response-first";
  interleavedNotifications?: boolean;
  invalidAnalysis?: boolean;
  unsupportedEphemeral?: boolean;
  jsonRpcErrors?: Record<
    string,
    { code?: number; message?: string; data?: unknown }
  >;
}

interface AdapterFixture {
  adapter: CodexAppServerSessions;
  logPath: string;
  root: string;
}

async function adapterFixture(
  config: FixtureConfig = {},
  executable = fixture,
): Promise<AdapterFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-codex-sessions-"));
  temporaryDirectories.add(root);
  const logPath = path.join(root, "calls.jsonl");
  const runtime = new CodexProcessRuntime({
    executable,
    socketPath: path.join(root, "codex-app-server.sock"),
    currentDirectory: root,
    environment: {
      ...process.env,
      FAKE_CODEX_CONFIG: JSON.stringify(config),
      FAKE_CODEX_LOG: logPath,
    },
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 100,
  });
  const adapter = new CodexAppServerSessions({
    runtime,
    clientVersion: "test-version",
  });
  adapters.add(adapter);
  return { adapter, logPath, root };
}

async function callLog(logPath: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(logPath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function protocolRequests(
  log: readonly Record<string, unknown>[],
  method: string,
): Array<Record<string, unknown>> {
  return log.flatMap((event) => {
    if (
      event.event !== "protocol_in" ||
      typeof event.message !== "object" ||
      event.message === null ||
      !("method" in event.message) ||
      event.message.method !== method
    )
      return [];
    return [event.message];
  });
}

afterEach(async () => {
  await Promise.allSettled([...adapters].map((adapter) => adapter.stop()));
  adapters.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe("CodexAppServerSessions", () => {
  it("owns one initialized runtime while mapping all three session lifecycles", async () => {
    const run = await adapterFixture({
      eventOrder: "notifications-first",
      interleavedNotifications: true,
    });

    await run.adapter.checkCompatibility();
    await run.adapter.start();
    const demonstration = await run.adapter.createSession({
      currentDirectory: run.root,
      retention: "managed",
    });
    await expect(run.adapter.runInteractive(demonstration)).resolves.toEqual({
      reason: "normal",
      exitCode: 0,
    });
    const conversation = await run.adapter.readConversation(demonstration);

    const analysis = await run.adapter.createSession({
      currentDirectory: run.root,
      retention: "managed",
    });
    const analysisResult = await run.adapter.runTurn(analysis, {
      prompt: "Analyze the artifact at /private/demonstration.md",
      filesystem: "read-only",
      network: false,
      expectedResult: "markdown",
      readableResources: ["/private/demonstration.md"],
    });
    await run.adapter.disposeSession(demonstration);
    await run.adapter.disposeSession(demonstration);

    const generation = await run.adapter.createSession({
      currentDirectory: run.root,
      retention: "persistent",
    });
    await expect(
      run.adapter.runInteractive(generation, {
        initialPrompt: "Create a skill from /private/skill-context.md",
        readableResources: ["/private/skill-context.md"],
      }),
    ).resolves.toEqual({ reason: "normal", exitCode: 0 });
    await run.adapter.stop();

    expect([demonstration, analysis, generation]).toEqual([
      "thread-demonstration",
      "thread-analysis",
      "thread-generation",
    ]);
    expect(conversation.turns).toHaveLength(1);
    expect(conversation.turns[0]?.items.map((item) => item.type)).toEqual([
      "user_message",
      "agent_message",
      "command_execution",
      "command_result",
      "tool_call",
      "tool_result",
      "file_change",
      "other",
    ]);
    expect(analysisResult).toEqual({
      status: "completed",
      content:
        "# Reusable workflow context\n\n1. Inspect the failure.\n2. Validate the fix.",
    });

    const log = await callLog(run.logPath);
    const initialize = protocolRequests(log, "initialize");
    expect(initialize).toHaveLength(1);
    expect(initialize[0]?.params).toEqual({
      clientInfo: {
        name: "happy_machine",
        title: "Happy Machine",
        version: "test-version",
      },
      capabilities: { experimentalApi: true },
    });
    const starts = protocolRequests(log, "thread/start");
    expect(starts.map((request) => request.params)).toEqual([
      { cwd: run.root, ephemeral: true },
      { cwd: run.root, ephemeral: true },
      { cwd: run.root },
    ]);
    const turnStart = protocolRequests(log, "turn/start")[0];
    expect(turnStart?.params).toEqual({
      threadId: analysis,
      input: [
        {
          type: "text",
          text: "Analyze the artifact at /private/demonstration.md",
        },
      ],
      cwd: run.root,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema: {
        type: "object",
        properties: {
          markdown: { type: "string", minLength: 1, pattern: "\\S" },
        },
        required: ["markdown"],
        additionalProperties: false,
      },
    });
    const deletes = protocolRequests(log, "thread/delete").map(
      (request) => (request.params as { threadId: string }).threadId,
    );
    expect(deletes).toEqual([demonstration, analysis]);
    expect(deletes).not.toContain(generation);
  });

  it("falls back from unsupported ephemeral creation to managed deletion", async () => {
    const run = await adapterFixture({ unsupportedEphemeral: true });
    await run.adapter.start();

    const session = await run.adapter.createSession({
      currentDirectory: run.root,
      retention: "managed",
    });
    await run.adapter.disposeSession(session);
    await run.adapter.stop();

    const log = await callLog(run.logPath);
    expect(
      protocolRequests(log, "thread/start").map((request) => request.params),
    ).toEqual([{ cwd: run.root, ephemeral: true }, { cwd: run.root }]);
    expect(protocolRequests(log, "thread/delete")).toHaveLength(1);
  });

  it("rejects empty structured Markdown without exposing returned content", async () => {
    const run = await adapterFixture({ invalidAnalysis: true });
    await run.adapter.start();
    const session = await run.adapter.createSession({
      currentDirectory: run.root,
      retention: "managed",
    });

    let thrown: unknown;
    try {
      await run.adapter.runTurn(session, {
        prompt: "Analyze private content",
        filesystem: "read-only",
        network: false,
        expectedResult: "markdown",
        readableResources: ["/private/demonstration.md"],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "CodexAppServerSessionsError",
      code: "protocol_error",
      message:
        "The Codex app-server returned an invalid structured analysis result.",
    });
    expect((thrown as Error).message).not.toContain("markdown");
  });

  it("maps vendor failures to safe adapter errors while retaining their cause", async () => {
    const secret = "CAPTURED-SECRET-VALUE";
    const run = await adapterFixture({
      jsonRpcErrors: {
        "thread/read": { code: -32091, message: secret },
      },
    });
    await run.adapter.start();
    const session = await run.adapter.createSession({
      currentDirectory: run.root,
      retention: "managed",
    });

    let thrown: unknown;
    try {
      await run.adapter.readConversation(session);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "CodexAppServerSessionsError",
      code: "operation_failed",
      message: "The Codex app-server could not read a conversation.",
    });
    expect((thrown as Error).message).not.toContain(secret);
    expect((thrown as Error).cause).toMatchObject({ message: secret });
  });

  it("maps a missing Codex executable to the technology-independent port error", async () => {
    const run = await adapterFixture({}, "/missing/happy-machine-codex");

    await expect(run.adapter.checkCompatibility()).rejects.toBeInstanceOf(
      AgentRuntimeUnavailableError,
    );
  });

  it("rejects operations outside the owned runtime lifecycle", async () => {
    const run = await adapterFixture();

    await expect(
      run.adapter.createSession({
        currentDirectory: run.root,
        retention: "managed",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerSessionsError",
      code: "invalid_state",
    });
    await expect(run.adapter.stop()).resolves.toBeUndefined();
  });
});
