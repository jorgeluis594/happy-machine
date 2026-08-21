import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProcessEntryPoint,
  type ProcessSignalSource,
} from "../src/composition-root.js";

const fakeCodex = path.resolve("tests/fixtures/fake-codex.mjs");
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe("create-skill successful end-to-end flow", () => {
  it("wires the full CLI journey through three isolated fake Codex sessions", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "happy-create-skill-e2e-"),
    );
    temporaryDirectories.add(root);
    const captureRoot = path.join(root, "capture");
    const projectRoot = path.join(root, "project");
    await Promise.all([mkdir(captureRoot), mkdir(projectRoot)]);
    const logPath = path.join(root, "fake-codex.jsonl");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const prompts: string[] = [];
    const answers = ["Investigate a production bug", "y"];
    const addSignalListener = vi.fn();
    const removeSignalListener = vi.fn();
    const signalSource: ProcessSignalSource = {
      once: addSignalListener,
      off: removeSignalListener,
    };
    const entryPoint = createProcessEntryPoint({
      codexExecutable: fakeCodex,
      codexUpgradeControlTransport: (transport) => Promise.resolve(transport),
      environment: { ...process.env, FAKE_CODEX_LOG: logPath },
      temporaryDirectory: captureRoot,
      streams: {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
      createSkillTerminal: {
        isStdinInteractive: () => true,
        isStdoutInteractive: () => true,
        question: (prompt) => {
          prompts.push(prompt);
          return Promise.resolve(answers.shift() ?? "");
        },
      },
      signalSource,
    });

    await expect(
      entryPoint(["create-skill", "--agent=codex"], projectRoot),
    ).resolves.toBe(0);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("What workflow");
    expect(prompts[1]).toContain("complete Codex conversation");
    expect(stdout).toEqual([
      "Skill creation finished. Temporary data cleanup completed.",
    ]);
    expect(stderr).toEqual([]);
    expect(addSignalListener).toHaveBeenCalledTimes(2);
    expect(removeSignalListener).toHaveBeenCalledTimes(2);

    const log = await readCallLog(logPath);
    const tuiStarts = eventsNamed(log, "tui_started");
    expect(tuiStarts).toHaveLength(2);
    expect(tuiStarts.map((event) => event.role)).toEqual([
      "demonstration",
      "generation",
    ]);
    expect(tuiStarts[0]).toMatchObject({
      role: "demonstration",
      threadId: "thread-demonstration",
    });
    expect(tuiStarts[0]).not.toHaveProperty("initialPrompt");
    const tuiSpawns = log.filter(
      (event) =>
        event.event === "spawn" &&
        Array.isArray(event.args) &&
        event.args[0] === "--remote" &&
        !event.args.includes("--help"),
    );
    expect(tuiSpawns.map((event) => event.args)).toEqual([
      ["--remote", expect.stringMatching(/^unix:\/\//)],
      [
        "--remote",
        expect.stringMatching(/^unix:\/\//),
        tuiStarts[1]?.initialPrompt,
      ],
    ]);

    const threadStarts = protocolRequests(log, "thread/start");
    expect(threadStarts).toHaveLength(1);
    expect(threadStarts.map((request) => request.params)).toEqual([
      { cwd: projectRoot },
    ]);

    const turnStarts = protocolRequests(log, "turn/start");
    expect(turnStarts).toHaveLength(1);
    expect(turnStarts[0]?.params).toMatchObject({
      threadId: "thread-analysis",
      cwd: projectRoot,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(
      new Set([
        tuiStarts[0]?.threadId,
        turnStarts[0]?.params?.threadId,
        tuiStarts[1]?.threadId,
      ]),
    ).toEqual(
      new Set(["thread-demonstration", "thread-analysis", "thread-generation"]),
    );

    const generation = tuiStarts[1];
    expect(generation).toMatchObject({
      role: "generation",
      threadId: "thread-generation",
      contextExists: true,
      demonstrationExists: false,
    });
    expect(generation?.initialPrompt).toContain(
      'Declared workflow: "Investigate a production bug"',
    );
    expect(generation?.initialPrompt).toContain("skill-context.md");
    expect(generation?.contextReference).toMatch(/skill-context\.md$/);

    const generationIndex = log.indexOf(generation);
    const demonstrationDeleteIndex = log.findIndex(
      (event) =>
        isProtocolRequest(event, "thread/delete") &&
        (event.message as ProtocolRequest).params?.threadId ===
          "thread-demonstration",
    );
    expect(demonstrationDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(demonstrationDeleteIndex).toBeLessThan(generationIndex);

    const deletedThreads = protocolRequests(log, "thread/delete").map(
      (request) => request.params?.threadId,
    );
    expect(deletedThreads).toEqual(["thread-demonstration", "thread-analysis"]);
    expect(deletedThreads).not.toContain("thread-generation");
    await expect(readdir(captureRoot)).resolves.toEqual([]);
  });
});

interface ProtocolRequest {
  method?: string;
  params?: Record<string, unknown>;
}

async function readCallLog(
  logPath: string,
): Promise<Array<Record<string, unknown>>> {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
