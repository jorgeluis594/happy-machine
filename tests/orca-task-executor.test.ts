import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExecutorReferences } from "../src/domain/execution/run.js";
import type { DiagnosticEntry } from "../src/ports/diagnostics.js";
import type { TaskLaunch } from "../src/ports/task-executor.js";
import { TaskExecutorError } from "../src/ports/task-executor.js";
import { OrcaTaskExecutor } from "../src/infrastructure/outbound/task-executor/orca/orca-task-executor.js";

const fixture = path.resolve("tests/fixtures/fake-orca.mjs");
const noDelay = () => Promise.resolve();

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
    instructions: "configured agent instructions",
    prompt: "configured prompt",
    allowedOutcomes: ["approved", "needs_revision"],
    runtime: "codex",
    timeoutMs: 5_000,
    attemptNumber: 1,
  };
}

async function calls(root: string): Promise<string[][]> {
  return (await readFile(path.join(root, ".fake-orca-calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

const terminalReferences = (): ExecutorReferences => ({
  executionId: "terminal-1",
  terminalHandle: "terminal-1",
});

describe("Orca terminal-only task executor", () => {
  it("creates plain Codex, persists its handle, waits 8 seconds, then sends the composed prompt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-order-"));
    const delays: number[] = [];
    let started: ExecutorReferences | undefined;
    const executor = new OrcaTaskExecutor(
      fixture,
      undefined,
      async (milliseconds) => {
        delays.push(milliseconds);
        expect(await calls(root)).toEqual([
          expect.arrayContaining(["terminal", "create", "--focus"]),
        ]);
        expect(existsSync(path.join(root, ".fake-prompt"))).toBe(false);
        expect(started).toEqual(terminalReferences());
      },
      noDelay,
    );
    const launch = await launchFixture(root);
    launch.prompt = "first line\nsecond line ' $() --flag";

    const execution = await executor.execute(launch, (references) => {
      started = references;
      return Promise.resolve();
    });

    expect(delays).toEqual([8_000]);
    expect(execution.references).toEqual(terminalReferences());
    const sent = await readFile(path.join(root, ".fake-prompt"), "utf8");
    expect(sent.startsWith(`${launch.prompt}\n\n---\n`)).toBe(true);
    expect((await calls(root))[0]).toEqual([
      "terminal",
      "create",
      "--worktree",
      "current",
      "--command",
      "codex",
      "--focus",
      "--json",
    ]);
    expect((await calls(root)).map((call) => call.slice(0, 2))).toEqual([
      ["terminal", "create"],
      ["terminal", "send"],
    ]);
  });

  it("keeps the configured prompt as the exact prefix before instructions and contract", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-prompt-"));
    const launch = await launchFixture(root);
    launch.prompt = "USER PROMPT EXACT\nwithout wrappers";
    const executor = new OrcaTaskExecutor(fixture, undefined, noDelay, noDelay);

    await executor.execute(launch, () => Promise.resolve());

    const sent = await readFile(path.join(root, ".fake-prompt"), "utf8");
    const command = await readFile(
      path.join(root, ".fake-codex-command"),
      "utf8",
    );
    expect(sent.startsWith(`${launch.prompt}\n\n---\n`)).toBe(true);
    expect(sent).toContain("configured agent instructions");
    expect(sent).toContain("Happy Machine execution context (required)");
    expect(sent).toContain(JSON.stringify(launch.contextPath));
    expect(sent).toContain(JSON.stringify(launch.resultPath));
    expect(sent).toContain('- "approved"\n- "needs_revision"');
    expect(sent).toContain('"documents": ["relative/path/to/document.md"]');
    expect(sent.indexOf(launch.instructions)).toBeGreaterThan(
      launch.prompt.length,
    );
    expect(command).not.toContain(launch.prompt);
  });

  it("launches OpenCode with the exact closed command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-opencode-"));
    const launch = await launchFixture(root);
    launch.runtime = "opencode";
    const executor = new OrcaTaskExecutor(fixture, undefined, noDelay, noDelay);

    await executor.execute(launch, () => Promise.resolve());

    expect((await calls(root))[0]).toEqual([
      "terminal",
      "create",
      "--worktree",
      "current",
      "--command",
      "opencode",
      "--focus",
      "--json",
    ]);
  });

  it.each([
    [undefined, undefined, "codex"],
    ["gpt-custom", undefined, "codex --model 'gpt-custom'"],
    [undefined, "high", `codex -c 'model_reasoning_effort="high"'`],
    [
      "gpt-custom",
      "high",
      `codex --model 'gpt-custom' -c 'model_reasoning_effort="high"'`,
    ],
  ])(
    "launches Codex with model %j and reasoning %j",
    async (model, reasoning, command) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-model-"));
      const launch = await launchFixture(root);
      launch.model = model;
      launch.reasoning = reasoning;
      const executor = new OrcaTaskExecutor(
        fixture,
        undefined,
        noDelay,
        noDelay,
      );

      await executor.execute(launch, () => Promise.resolve());

      expect((await calls(root))[0]).toContain(command);
    },
  );

  it.each(["space value", `quote ' and "`, "$(touch nope)", "`touch nope`"])(
    "quotes adversarial models as literal data: %j",
    async (model) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "happy-orca-safe-model-"),
      );
      const launch = await launchFixture(root);
      launch.model = model;
      const executor = new OrcaTaskExecutor(
        fixture,
        undefined,
        noDelay,
        noDelay,
      );

      await executor.execute(launch, () => Promise.resolve());

      const create = (await calls(root))[0];
      const command = create[create.indexOf("--command") + 1];
      expect(command).toBe(`codex --model '${model.replaceAll("'", `'"'"'`)}'`);
      expect(existsSync(path.join(root, "nope"))).toBe(false);
    },
  );

  it.each([
    ["codex" as const, "high", `codex -c 'model_reasoning_effort="high"'`],
    ["opencode" as const, "max", "opencode run --interactive --variant 'max'"],
  ])(
    "launches %s with configured reasoning",
    async (runtime, reasoning, command) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "happy-orca-reasoning-"),
      );
      const launch = await launchFixture(root);
      launch.runtime = runtime;
      launch.reasoning = reasoning;
      const executor = new OrcaTaskExecutor(
        fixture,
        undefined,
        noDelay,
        noDelay,
      );

      await executor.execute(launch, () => Promise.resolve());

      expect((await calls(root))[0]).toContain(command);
    },
  );

  it.each([
    "space value",
    `quote ' and "`,
    "$(touch nope)",
    "`touch nope`",
    "line one\nline two",
  ])("quotes adversarial reasoning as literal data: %j", async (reasoning) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "happy-orca-safe-reasoning-"),
    );
    const launch = await launchFixture(root);
    launch.reasoning = reasoning;
    const executor = new OrcaTaskExecutor(fixture, undefined, noDelay, noDelay);

    await executor.execute(launch, () => Promise.resolve());

    const create = (await calls(root))[0];
    const command = create[create.indexOf("--command") + 1];
    const serialized = JSON.stringify(reasoning);
    expect(command).toBe(
      `codex -c '${`model_reasoning_effort=${serialized}`.replaceAll("'", `'"'"'`)}'`,
    );
    expect(existsSync(path.join(root, "nope"))).toBe(false);
  });

  it("never interpolates dynamic or shell-like content into the runtime command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-quote-"));
    const launch = await launchFixture(root);
    launch.runtime = "opencode";
    launch.prompt = '/goal don\'t run `code` $(anything) --flag\n"double"';
    launch.instructions = "don't replace $(anything) or `this`\n--dangerous";
    const executor = new OrcaTaskExecutor(fixture, undefined, noDelay, noDelay);

    await executor.execute(launch, () => Promise.resolve());

    const create = (await calls(root))[0];
    const command = create[create.indexOf("--command") + 1];
    expect(command).toBe("opencode");
    expect(create).not.toContain(launch.instructions);
    expect(create).not.toContain(launch.prompt);
    expect(create).toContain("--focus");
    const sent = await readFile(path.join(root, ".fake-prompt"), "utf8");
    expect(sent.startsWith(launch.prompt)).toBe(true);
    expect(sent).toContain(launch.instructions);
  });

  it("rejects an unexpected runtime before constructing an Orca command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-runtime-"));
    const launch = await launchFixture(root);
    Object.assign(launch, { runtime: "codex; arbitrary-command" });
    const executor = new OrcaTaskExecutor(fixture, undefined, noDelay, noDelay);

    await expect(
      executor.execute(launch, () => Promise.resolve()),
    ).rejects.toThrow("Unsupported agent runtime: codex; arbitrary-command");
    expect(existsSync(path.join(root, ".fake-orca-calls.jsonl"))).toBe(false);
  });

  it("never invokes Orca orchestration or terminal wait", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-pure-"));
    const executor = new OrcaTaskExecutor(fixture, undefined, noDelay, noDelay);
    await executor.execute(await launchFixture(root), () => Promise.resolve());
    const invoked = await calls(root);
    expect(invoked.some((call) => call[0] === "orchestration")).toBe(false);
    expect(
      invoked.some((call) => call[0] === "terminal" && call[1] === "wait"),
    ).toBe(false);
  });

  it("closes only the new tab when startup is cancelled during the delay", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-abort-"));
    const controller = new AbortController();
    const executor = new OrcaTaskExecutor(
      fixture,
      undefined,
      (_milliseconds, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("startup aborted"),
              ),
            { once: true },
          );
          controller.abort(new Error("cancelled during startup"));
        }),
      noDelay,
    );
    const launch = await launchFixture(root);
    launch.signal = controller.signal;

    await expect(
      executor.execute(launch, () => Promise.resolve()),
    ).rejects.toThrow("cancelled during startup");

    const invoked = await calls(root);
    expect(invoked.some((call) => call[1] === "send")).toBe(false);
    expect(invoked.at(-1)).toEqual([
      "terminal",
      "close",
      "--terminal",
      "terminal-1",
      "--tab",
      "--json",
    ]);
  });

  it("closes the new tab when durable start persistence fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-start-"));
    const executor = new OrcaTaskExecutor(fixture, undefined, noDelay, noDelay);
    await expect(
      executor.execute(await launchFixture(root), () => {
        throw new Error("persistence failed");
      }),
    ).rejects.toThrow("persistence failed");
    expect((await calls(root)).at(-1)?.slice(0, 2)).toEqual([
      "terminal",
      "close",
    ]);
  });

  it.each([
    [
      "terminal create",
      { terminal: {} },
      "Orca create response expected result.terminal.handle",
      false,
    ],
    [
      "terminal send",
      { send: {} },
      "Orca send response expected result.send.handle",
      true,
    ],
  ])(
    "rejects malformed %s JSON and cleans up when a handle exists",
    async (operation, result, message, closes) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-json-"));
      await writeFile(
        path.join(root, ".fake-orca-response-overrides.json"),
        JSON.stringify({
          [operation]: { id: "rpc", ok: true, result },
        }),
      );
      const executor = new OrcaTaskExecutor(
        fixture,
        undefined,
        noDelay,
        noDelay,
      );
      await expect(
        executor.execute(await launchFixture(root), () => Promise.resolve()),
      ).rejects.toThrow(message);
      expect((await calls(root)).some((call) => call[1] === "close")).toBe(
        closes,
      );
    },
  );

  it("rejects a mismatched or unaccepted terminal send receipt", async () => {
    for (const [send, message] of [
      [
        { handle: "other-terminal", accepted: true },
        "returned terminal other-terminal instead of terminal-1",
      ],
      [
        { handle: "terminal-1", accepted: false },
        "did not accept input for terminal terminal-1",
      ],
    ] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-send-"));
      await writeFile(
        path.join(root, ".fake-orca-response-overrides.json"),
        JSON.stringify({
          "terminal send": { id: "rpc", ok: true, result: { send } },
        }),
      );
      const executor = new OrcaTaskExecutor(
        fixture,
        undefined,
        noDelay,
        noDelay,
      );
      await expect(
        executor.execute(await launchFixture(root), () => Promise.resolve()),
      ).rejects.toThrow(message);
    }
  });

  it("returns after any non-empty result so application validation remains authoritative", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-result-"));
    await writeFile(path.join(root, ".fake-raw-result"), "not json\n");
    const executor = new OrcaTaskExecutor(fixture, undefined, noDelay, noDelay);
    await expect(
      executor.execute(await launchFixture(root), () => Promise.resolve()),
    ).resolves.toMatchObject({ references: terminalReferences() });
  });

  it("fails when the terminal stops before producing a result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-stopped-"));
    await writeFile(path.join(root, ".fake-block-check"), "block\n");
    await writeFile(path.join(root, ".fake-terminal-state"), "stopped\n");
    const executor = new OrcaTaskExecutor(fixture, undefined, noDelay, noDelay);
    await expect(
      executor.execute(await launchFixture(root), () => Promise.resolve()),
    ).rejects.toThrow("stopped before producing result.json");
  });

  it("streams bounded terminal output only when diagnostics are enabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-debug-"));
    const entries: DiagnosticEntry[] = [];
    const executor = new OrcaTaskExecutor(
      fixture,
      {
        enabled: true,
        replay: false,
        emit: (entry) => entries.push(entry),
      },
      noDelay,
      noDelay,
    );
    await executor.execute(await launchFixture(root), () => Promise.resolve());
    expect(
      entries
        .filter((entry) => entry.kind === "transcript")
        .map((entry) => entry.text),
    ).toEqual(["agent progress", "match"]);
    expect(entries.some((entry) => entry.name === "read_started")).toBe(true);
    expect(
      entries.find((entry) => entry.name === "read_finished")?.data?.exitCode,
    ).toBe(0);
    expect(
      entries.find((entry) => entry.kind === "transcript")?.context
        ?.executionId,
    ).toBe("terminal-1");
  });

  it("cancels and reconciles exactly the persisted terminal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-cancel-"));
    const executor = new OrcaTaskExecutor(fixture, undefined, noDelay, noDelay);
    expect(await executor.reconcile(terminalReferences(), root)).toBe("active");
    await executor.cancel(terminalReferences(), root);
    expect(await executor.reconcile(terminalReferences(), root)).toBe(
      "stopped",
    );
    expect((await calls(root)).map((call) => call.slice(0, 2))).toEqual([
      ["terminal", "show"],
      ["terminal", "close"],
      ["terminal", "show"],
    ]);
  });

  it("treats a stale handle as stopped during reconciliation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-stale-"));
    await writeFile(
      path.join(root, ".fake-orca-failures.json"),
      JSON.stringify({
        "terminal show": {
          error: {
            code: "terminal_handle_stale",
            message: "terminal_handle_stale",
          },
        },
      }),
    );
    const executor = new OrcaTaskExecutor(fixture, undefined, noDelay, noDelay);
    await expect(executor.reconcile(terminalReferences(), root)).resolves.toBe(
      "stopped",
    );
  });

  it("recovers terminal-only and legacy terminal references without orchestration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-recover-"));
    const executor = new OrcaTaskExecutor(fixture, undefined, noDelay, noDelay);
    expect(await executor.recover("identity", undefined, root)).toEqual({
      status: "not_found",
    });

    const active = await executor.recover(
      "identity",
      terminalReferences(),
      root,
      path.join(root, "missing-result.json"),
    );
    expect(active).toMatchObject({
      status: "active",
      references: terminalReferences(),
    });

    const legacy: ExecutorReferences = {
      taskId: "legacy-task",
      dispatchId: "legacy-dispatch",
      terminalHandle: "terminal-1",
    };
    const recoveredLegacy = await executor.recover(
      "identity",
      legacy,
      root,
      path.join(root, "missing-result.json"),
    );
    expect(recoveredLegacy).toMatchObject({
      status: "active",
      references: {
        executionId: "terminal-1",
        taskId: "legacy-task",
        dispatchId: "legacy-dispatch",
      },
    });
    expect(
      (await calls(root)).some((call) => call[0] === "orchestration"),
    ).toBe(false);
  });

  it("uses an existing result as authoritative recovery evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-complete-"));
    const resultPath = path.join(root, "result.json");
    await writeFile(resultPath, '{"outcome":"approved","documents":[]}\n');
    const executor = new OrcaTaskExecutor(fixture, undefined, noDelay, noDelay);
    await expect(
      executor.recover("identity", terminalReferences(), root, resultPath),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      executor.recover(
        "identity",
        { taskId: "legacy-task", dispatchId: "legacy-dispatch" },
        root,
        resultPath,
      ),
    ).resolves.toMatchObject({ status: "completed" });
    expect(existsSync(path.join(root, ".fake-orca-calls.jsonl"))).toBe(false);
  });

  it("preserves structured Orca failure diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-orca-failure-"));
    await writeFile(
      path.join(root, ".fake-orca-failures.json"),
      JSON.stringify({
        "terminal create": {
          error: { code: "terminal_create", message: "Could not create tab" },
        },
      }),
    );
    const executor = new OrcaTaskExecutor(fixture, undefined, noDelay, noDelay);
    let caught: unknown;
    try {
      await executor.execute(await launchFixture(root), () =>
        Promise.resolve(),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TaskExecutorError);
    expect(caught).toMatchObject({
      message: "Orca create failed (1): terminal_create: Could not create tab",
    });
  });
});
