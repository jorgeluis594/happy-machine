import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { OrcaTaskExecutor } from "../src/infrastructure/outbound/task-executor/orca/orca-task-executor.js";

const fixture = path.resolve("tests/fixtures/fake-orca.mjs");

beforeAll(async () => chmod(fixture, 0o755));

describe("Orca timeout reconciliation adapter", () => {
  it.each([
    ["starting", "active"],
    ["ready", "active"],
    ["stopping", "active"],
    ["stopped", "stopped"],
    ["failed", "stopped"],
    ["succeeded", "stopped"],
    ["start_unknown", "unknown"],
    ["stop_unknown", "unknown"],
    ["abandoned", "unknown"],
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
