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
