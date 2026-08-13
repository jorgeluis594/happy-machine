import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { TaskLaunch } from "../src/ports/task-executor.js";
import { TaskExecutorError } from "../src/ports/task-executor.js";
import { OrcaTaskExecutor } from "../src/infrastructure/outbound/task-executor/orca/orca-task-executor.js";
import type { DiagnosticEntry } from "../src/ports/diagnostics.js";

const fixture = path.resolve("tests/fixtures/fake-orca.mjs");

beforeAll(async () => chmod(fixture, 0o755));

async function launchFixture(root: string): Promise<TaskLaunch> {
  const outputDirectory = path.join(root, "output");
  await mkdir(outputDirectory);
  const contextPath = path.join(root, "context.md");
  await writeFile(contextPath, "context\n");
  return {
    identity: "run:state:1:task:1",
    projectWorkspace: root,
    contextPath,
    outputDirectory,
    resultPath: path.join(root, "result.json"),
    instructions: "instructions",
    prompt: "prompt",
    allowedOutcomes: ["approved", "needs_revision"],
    model: "model",
    timeoutMs: 5_000,
    attemptNumber: 1,
  };
}

describe("Orca timeout reconciliation adapter", () => {
  it("streams bounded transcript only when diagnostics are enabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-debug-"));
    const entries: DiagnosticEntry[] = [];
    const executor = new OrcaTaskExecutor(fixture, {
      enabled: true,
      replay: false,
      emit: (entry) => entries.push(entry),
    });
    await executor.execute(await launchFixture(root), () => Promise.resolve());
    const transcript = entries.filter((entry) => entry.kind === "transcript");
    expect(transcript.map((entry) => entry.text)).toEqual([
      "agent progress",
      '[tool rg] {"pattern":"needle"}',
      "[tool result] match",
    ]);
    expect(JSON.stringify(entries)).not.toContain("hidden system prompt");
    expect(JSON.stringify(entries)).not.toContain("hidden user prompt");
    expect(JSON.stringify(entries)).not.toContain("instructions");
    expect(entries.some((entry) => entry.name === "worker-read_started")).toBe(
      true,
    );
    expect(
      entries.find((entry) => entry.name === "worker-read_finished")?.data
        ?.exitCode,
    ).toBe(0);
  });

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
        allowedOutcomes: ["approved", "needs_revision"],
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

    const contract = JSON.parse(
      await readFile(path.join(root, ".fake-contract.json"), "utf8"),
    ) as { instructions: string; prompt: string };
    expect(contract.instructions).toBe("instructions");
    expect(contract.prompt).toContain(
      `prompt\n\n---\nHappy Machine result contract (required)`,
    );
    expect(contract.prompt).toContain(
      JSON.stringify(path.join(output, "result.json")),
    );
    expect(contract.prompt).toContain(JSON.stringify(output));
    expect(contract.prompt).toContain('- "approved"\n- "needs_revision"');
    expect(contract.prompt).toContain(
      '"documents": ["relative/path/to/document.md"]',
    );
    expect(contract.prompt).toContain(
      "Only result.json controls the workflow transition",
    );
    expect(contract.prompt).not.toContain("destination-state");

    expect(observed).toMatchObject([
      { id: "q-1", type: "question", status: "pending" },
      { id: "e-1", type: "escalation", status: "pending" },
      { id: "q-1", type: "question", status: "resolved" },
    ]);
  });

  it("uses resource IDs from the RPC result instead of the envelope ID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-ids-"));
    const executor = new OrcaTaskExecutor(fixture);
    let references:
      Parameters<Parameters<OrcaTaskExecutor["execute"]>[1]>[0] | undefined;

    await executor.execute(await launchFixture(root), (started) => {
      references = started;
      return Promise.resolve();
    });

    expect(references).toEqual({
      runId: "orca-run-1",
      taskId: "orca-task-1",
      dispatchId: "orca-dispatch-1",
      terminalHandle: "terminal-1",
    });
    const calls = (
      await readFile(path.join(root, ".fake-orca-calls.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const workerStart = calls.find(
      (call) => call[0] === "orchestration" && call[1] === "worker-start",
    );
    expect(workerStart?.[workerStart.indexOf("--task") + 1]).toBe(
      "orca-task-1",
    );
    expect(
      calls.some(
        (call) => call[0] === "orchestration" && call[1] === "worker-read",
      ),
    ).toBe(false);
  });

  it("fails before the next side effect when a receipt is malformed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-shape-"));
    await writeFile(
      path.join(root, ".fake-orca-response-overrides.json"),
      JSON.stringify({
        "orchestration run-create": {
          id: "rpc-envelope-id",
          ok: true,
          result: { run: {} },
        },
      }),
    );
    const executor = new OrcaTaskExecutor(fixture);

    await expect(
      executor.execute(await launchFixture(root), () => Promise.resolve()),
    ).rejects.toMatchObject({
      message:
        "Orca run-create response expected result.run.id to be a non-empty string",
    });
    const calls = (
      await readFile(path.join(root, ".fake-orca-calls.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ["orchestration", "run-create"],
    ]);
  });

  it("rejects a worker receipt for a different task", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "happy-orca-task-mismatch-"),
    );
    await writeFile(
      path.join(root, ".fake-orca-response-overrides.json"),
      JSON.stringify({
        "orchestration worker-start": {
          id: "rpc-envelope-id",
          ok: true,
          result: {
            taskId: "other-task",
            dispatchId: "orca-dispatch-1",
            state: "ready",
          },
        },
      }),
    );
    const executor = new OrcaTaskExecutor(fixture);

    await expect(
      executor.execute(await launchFixture(root), () => Promise.resolve()),
    ).rejects.toMatchObject({
      message:
        "Orca worker-start returned task other-task instead of created task orca-task-1",
    });
  });

  it("turns an explicit failed worker completion into an executor failure", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "happy-orca-worker-failed-"),
    );
    await writeFile(
      path.join(root, ".fake-check-sequence.json"),
      JSON.stringify([
        {
          messages: [
            {
              id: "worker-message",
              type: "worker_done",
              payload: JSON.stringify({
                dispatchId: "orca-dispatch-1",
                outcome: "failed",
              }),
            },
          ],
        },
      ]),
    );
    const executor = new OrcaTaskExecutor(fixture);

    await expect(
      executor.execute(await launchFixture(root), () => Promise.resolve()),
    ).rejects.toMatchObject({
      message: "Orca worker orca-dispatch-1 reported failed completion",
    });
  });

  it("surfaces a structured stdout error from a failed Orca command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-error-"));
    await writeFile(
      path.join(root, ".fake-orca-failures.json"),
      JSON.stringify({
        "orchestration worker-start": {
          exitCode: 1,
          error: {
            code: "task_not_found",
            message: "Task rpc-envelope-id was not found",
          },
        },
      }),
    );
    const executor = new OrcaTaskExecutor(fixture);

    try {
      await executor.execute(await launchFixture(root), () =>
        Promise.resolve(),
      );
      throw new Error("expected execute to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskExecutorError);
      expect((error as Error).message).toBe(
        "Orca worker-start failed (1): task_not_found: Task rpc-envelope-id was not found",
      );
      const stdout = (error as TaskExecutorError).logs.stdout;
      expect(stdout).toContain('"run":{"id":"orca-run-1"}');
      expect(stdout).toContain('"task":{"id":"orca-task-1"}');
      expect(stdout).toContain('"code":"task_not_found"');
      expect((error as TaskExecutorError).logs.stderr).toBe("");
    }
  });

  it("rejects an unsuccessful RPC envelope even when Orca exits zero", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-rpc-error-"));
    await writeFile(
      path.join(root, ".fake-orca-response-overrides.json"),
      JSON.stringify({
        "orchestration worker-start": {
          id: "rpc-envelope-id",
          ok: false,
          error: {
            code: "worker_rejected",
            message: "Worker could not start",
          },
        },
      }),
    );
    const executor = new OrcaTaskExecutor(fixture);

    await expect(
      executor.execute(await launchFixture(root), () => Promise.resolve()),
    ).rejects.toMatchObject({
      message:
        "Orca worker-start failed: worker_rejected: Worker could not start",
    });
  });

  it.each([
    [
      "stderr",
      { exitCode: 1, stdout: "not json", stderr: "connection lost" },
      "Orca worker-start failed (1): connection lost",
    ],
    [
      "plain stdout",
      { exitCode: 1, stdout: "plain worker failure" },
      "Orca worker-start failed (1): plain worker failure",
    ],
    [
      "invalid success output",
      { exitCode: 0, stdout: "not json" },
      "Orca worker-start returned invalid JSON",
    ],
    [
      "non-ready worker receipt",
      {
        exitCode: 1,
        stdout: JSON.stringify({
          id: "rpc-worker-failure",
          ok: true,
          result: {
            state: "failed",
            failedStage: "agent_launch",
            lastError: "Agent did not become ready",
          },
        }),
      },
      "Orca worker-start failed (1): agent_launch: Agent did not become ready",
    ],
  ])("uses the %s diagnostic fallback", async (_name, failure, message) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "happy-orca-error-fallback-"),
    );
    await writeFile(
      path.join(root, ".fake-orca-failures.json"),
      JSON.stringify({ "orchestration worker-start": failure }),
    );
    const executor = new OrcaTaskExecutor(fixture);

    await expect(
      executor.execute(await launchFixture(root), () => Promise.resolve()),
    ).rejects.toMatchObject({ message });
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
