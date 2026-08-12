import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { OrcaTaskExecutor } from "../src/infrastructure/outbound/task-executor/orca/orca-task-executor.js";

const fixture = path.resolve("tests/fixtures/fake-orca.mjs");

beforeAll(async () => chmod(fixture, 0o755));

describe("Orca timeout reconciliation adapter", () => {
  it("consumes questions, escalations, and external resolutions before ordinary completion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-events-"));
    const output = path.join(root, "output");
    await mkdir(output);
    const contextPath = path.join(root, "context.md");
    await writeFile(contextPath, "context\n");
    await writeFile(
      path.join(root, ".fake-check-sequence.json"),
      JSON.stringify([
        {
          messages: [
            { type: "question", questionId: "q-1", message: "Approve?" },
          ],
        },
        {
          messages: [
            { type: "escalation", escalationId: "e-1", reason: "Review" },
          ],
        },
        {
          messages: [
            {
              type: "question_resolved",
              questionId: "q-1",
              status: "answered",
            },
          ],
        },
        {
          messages: [
            {
              type: "worker_done",
              outcome: "succeeded",
              dispatchId: "orca-dispatch-1",
            },
          ],
        },
      ]),
    );
    const observed: Array<{ id: string; status: string; type: string }> = [];
    const executor = new OrcaTaskExecutor(fixture);

    await executor.execute(
      {
        identity: "run:state:1:task:1",
        projectWorkspace: root,
        contextPath,
        outputDirectory: output,
        resultPath: path.join(output, "result.json"),
        instructions: "instructions",
        prompt: "prompt",
        model: "model",
        timeoutMs: 5_000,
        attemptNumber: 1,
      },
      () => Promise.resolve(),
      (event) => {
        observed.push(event);
        return Promise.resolve();
      },
    );

    expect(observed).toMatchObject([
      { id: "q-1", type: "question", status: "pending" },
      { id: "e-1", type: "escalation", status: "pending" },
      { id: "q-1", type: "question", status: "resolved" },
    ]);
  });

  it.each([
    ["starting", "active"],
    ["ready", "active"],
    ["stopping", "active"],
    ["stopped", "stopped"],
    ["failed", "stopped"],
    ["succeeded", "stopped"],
    ["start_unknown", "unknown"],
    ["stop_unknown", "unknown"],
    ["abandoned", "stopped"],
  ] as const)("maps Orca worker state %s to %s", async (state, expected) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-state-"));
    await writeFile(path.join(root, ".fake-worker-state"), state);
    const executor = new OrcaTaskExecutor(fixture);
    await expect(
      executor.reconcile({ taskId: "task", dispatchId: "dispatch" }, root),
    ).resolves.toBe(expected);
  });

  it("requests cancellation for exactly the persisted dispatch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-stop-"));
    const executor = new OrcaTaskExecutor(fixture);
    await executor.cancel(
      { taskId: "task", dispatchId: "dispatch-to-stop" },
      root,
    );
    const [call] = (
      await readFile(path.join(root, ".fake-orca-calls.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(call).toEqual([
      "orchestration",
      "worker-stop",
      "--dispatch",
      "dispatch-to-stop",
      "--json",
    ]);
  });
});

describe("Orca durable recovery adapter", () => {
  it("returns not_found when no task has the stable attempt identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-recovery-"));
    const executor = new OrcaTaskExecutor(fixture);
    await expect(
      executor.recover("run:state:1:task:1", undefined, root),
    ).resolves.toEqual({ status: "not_found" });
  });

  it.each([
    ["starting", "active"],
    ["ready", "active"],
    ["stopping", "active"],
    ["succeeded", "completed"],
    ["stopped", "completed"],
    ["failed", "failed"],
    ["abandoned", "failed"],
    ["start_unknown", "start_unknown"],
    ["stop_unknown", "stop_unknown"],
  ] as const)(
    "finds provenance and maps %s to %s",
    async (workerState, expected) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "happy-orca-recovery-"),
      );
      const identity = "run:state:1:task:1";
      await writeFile(path.join(root, ".fake-recovery-identity"), identity);
      await writeFile(path.join(root, ".fake-recovery-state"), workerState);
      const executor = new OrcaTaskExecutor(fixture);

      const observation = await executor.recover(identity, undefined, root);
      expect(observation).toMatchObject({
        status: expected,
        references: {
          taskId: "recovered-task",
          dispatchId: "recovered-dispatch",
          terminalHandle: "recovered-terminal",
        },
      });
      const calls = (
        await readFile(path.join(root, ".fake-orca-calls.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls.map((call) => call.slice(0, 2))).toEqual([
        ["orchestration", "task-list"],
        ["orchestration", "dispatch-show"],
      ]);
    },
  );
});
