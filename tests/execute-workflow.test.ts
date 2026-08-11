import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ExecuteWorkflow } from "../src/application/use-cases/execute-workflow.js";
import type { RunRecord } from "../src/domain/execution/run.js";
import { Cli } from "../src/infrastructure/inbound/cli/cli.js";
import { FilesystemProjectDefinitions } from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";
import { FilesystemRunRepository } from "../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";
import { OrcaTaskExecutor } from "../src/infrastructure/outbound/task-executor/orca/orca-task-executor.js";
import type { ProjectDefinitions } from "../src/ports/project-definitions.js";
import type { RunRepository } from "../src/ports/run-repository.js";
import type { TaskExecutor } from "../src/ports/task-executor.js";

const fixture = path.resolve("tests/fixtures/fake-orca.mjs");
const temporaryDirectories: string[] = [];

beforeAll(async () => chmod(fixture, 0o755));
afterEach(() => {
  temporaryDirectories.length = 0;
});

async function project(
  outcome: "approved" | "rejected" = "approved",
  explicitDefaults = false,
): Promise<{ root: string; workflow: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-machine-test-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "agents"));
  await mkdir(path.join(root, "workflows"));
  await writeFile(
    path.join(root, "agents", "worker.md"),
    "# Worker\nFollow the task.\n",
  );
  await writeFile(
    path.join(root, "happy-machine.yaml"),
    [
      "version: 1",
      ...(explicitDefaults
        ? ["executor:", "  type: orca", "workspace:", "  mode: direct"]
        : []),
      "agents:",
      "  worker:",
      "    instructions: agents/worker.md",
      "    model: test-model",
      "defaults:",
      "  attempt_timeout: 5s",
      "",
    ].join("\n"),
  );
  const workflow = path.join(root, "workflows", "one.yaml");
  await writeFile(
    workflow,
    [
      "version: 1",
      "id: one-state",
      "initial_state: review",
      "states:",
      "  review:",
      "    type: agent",
      "    agent: worker",
      "    prompt: Choose an outcome and write the structured result.",
      "    outcomes:",
      "      approved: $succeeded",
      "      rejected: $failed",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(root, ".fake-outcome"), outcome);
  await writeFile(path.join(root, ".fake-require-run-id-marker"), "required");
  await writeFile(path.join(root, ".fake-require-snapshot-marker"), "required");
  return { root, workflow };
}

function cli(projectRoot?: string) {
  let id = 0;
  const useCase = new ExecuteWorkflow(
    new FilesystemProjectDefinitions(),
    new FilesystemRunRepository(),
    new OrcaTaskExecutor(fixture),
    () => new Date("2026-08-11T12:00:00.000Z"),
    () => `id-${++id}`,
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    cli: new Cli(useCase, {
      stdout: (line) => {
        stdout.push(line);
        if (projectRoot && line.startsWith("run_"))
          writeFileSync(path.join(projectRoot, ".run-id-printed"), line);
      },
      stderr: (line) => stderr.push(line),
    }),
    stdout,
    stderr,
  };
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

async function storedRun(root: string): Promise<RunRecord> {
  const runId = (await import("node:fs/promises"))
    .readdir(path.join(root, ".happy-machine", "runs"))
    .then((ids) => ids[0]);
  return parseJson(
    await readFile(
      path.join(root, ".happy-machine", "runs", await runId, "run.json"),
      "utf8",
    ),
  ) as RunRecord;
}

async function storedRunById(root: string, runId: string): Promise<RunRecord> {
  return parseJson(
    await readFile(
      path.join(root, ".happy-machine", "runs", runId, "run.json"),
      "utf8",
    ),
  ) as RunRecord;
}

async function allFileContents(directory: string): Promise<string> {
  const contents: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) contents.push(await allFileContents(target));
    else contents.push(await readFile(target, "utf8"));
  }
  return contents.join("\n");
}

describe("happy-machine execute", () => {
  it.each([false, true])(
    "discovers and executes from the project root (explicit defaults: %s)",
    async (explicitDefaults) => {
      const setup = await project("approved", explicitDefaults);
      const app = cli(setup.root);
      const exit = await app.cli.run(
        ["execute", path.relative(setup.root, setup.workflow)],
        setup.root,
      );
      expect(exit).toBe(0);
      expect(app.stdout).toEqual(["run_id-1", "Run run_id-1: succeeded"]);
    },
  );

  it("discovers the nearest project from a nested directory and resolves paths from its root", async () => {
    const setup = await project();
    const nested = path.join(setup.root, "deep", "inside");
    await mkdir(nested, { recursive: true });
    const app = cli(setup.root);
    expect(
      await app.cli.run(
        ["execute", path.relative(nested, setup.workflow)],
        nested,
      ),
    ).toBe(0);
    const run = await storedRun(setup.root);
    expect(run.projectRoot).toBe(setup.root);
    expect(run.workflowPath).toBe(setup.workflow);
  });

  it("fails before allocating a run or invoking Orca when no project exists", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "happy-machine-missing-"),
    );
    const app = cli();
    expect(await app.cli.run(["execute", "workflow.yaml"], root)).toBe(1);
    expect(app.stdout).toEqual([]);
    await expect(
      readFile(path.join(root, ".fake-orca-calls.jsonl")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(root, ".happy-machine", "runs")),
    ).rejects.toThrow();
  });

  it("performs no run, workspace, ID, callback, or executor side effect after any definition error", async () => {
    const calls: string[] = [];
    const definitions: ProjectDefinitions = {
      load: () => {
        calls.push("definitions.load");
        return Promise.reject(new Error("invalid definition"));
      },
    };
    const runs = {
      createSnapshot: () => {
        calls.push("runs.createSnapshot");
        return Promise.reject(new Error("must not snapshot"));
      },
      save: () => {
        calls.push("runs.save");
        return Promise.resolve();
      },
      prepareVisitContext: () => {
        calls.push("runs.prepareVisitContext");
        return Promise.reject(new Error("must not prepare context"));
      },
      prepareAttempt: () => {
        calls.push("runs.prepareAttempt");
        return Promise.reject(new Error("must not prepare"));
      },
      readResult: () => {
        calls.push("runs.readResult");
        return Promise.reject(new Error("must not read"));
      },
    } as RunRepository;
    const executor = {
      execute: () => {
        calls.push("executor.execute");
        return Promise.reject(new Error("must not execute"));
      },
    } as TaskExecutor;
    const useCase = new ExecuteWorkflow(
      definitions,
      runs,
      executor,
      () => {
        calls.push("clock");
        return new Date();
      },
      () => {
        calls.push("makeId");
        return "forbidden";
      },
    );
    await expect(
      useCase.execute({
        workflowPath: "invalid.yaml",
        currentDirectory: "/project",
        onRunAllocated: () => calls.push("onRunAllocated"),
      }),
    ).rejects.toThrow("invalid definition");
    expect(calls).toEqual(["definitions.load"]);
  });

  it.each([
    ["approved", 0, "succeeded", "$succeeded"],
    ["rejected", 1, "failed", "$failed"],
  ] as const)(
    "routes structured outcome %s to the declared terminal",
    async (outcome, expectedExit, status, target) => {
      const setup = await project(outcome);
      const app = cli(setup.root);
      expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(
        expectedExit,
      );
      const run = await storedRun(setup.root);
      expect(run.status).toBe(status);
      expect(run.terminalTarget).toBe(target);
      expect(run.visits[0].outcome).toBe(outcome);
    },
  );

  it("uses only result.json for routing and durably attributes the launch, logs, and outcome", async () => {
    const setup = await project("approved");
    const app = cli(setup.root);
    expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(0);
    const run = await storedRun(setup.root);
    const attempt = run.visits[0].task.attempts[0];
    expect(run.visits[0]).toMatchObject({
      stateId: "review",
      number: 1,
      task: { id: "review-task" },
    });
    expect(attempt).toMatchObject({
      id: "run_id-1:review:1:review-task:1",
      number: 1,
      status: "succeeded",
      outcome: "approved",
      executor: {
        runId: "orca-run-1",
        taskId: "orca-task-1",
        dispatchId: "orca-dispatch-1",
        terminalHandle: "terminal-1",
      },
    });
    expect(attempt.logs.stdout).toContain(
      "misleading stdout outcome: rejected",
    );
    expect(attempt.logs.stderr).toContain(
      "misleading stderr outcome: rejected",
    );
    expect(run.events.map((event: { type: string }) => event.type)).toEqual([
      "run_created",
      "state_entered",
      "attempt_launching",
      "attempt_started",
      "attempt_succeeded",
      "run_terminal",
    ]);
    expect(run.events[0].data.definitionSnapshotIdentity).toBe(
      run.definitionSnapshot.identity,
    );
    const contract = parseJson(
      await readFile(path.join(setup.root, ".fake-contract.json"), "utf8"),
    ) as {
      happyMachineAttemptIdentity: string;
      projectWorkspace: string;
      contextPath: string;
      outputDirectory: string;
      resultPath: string;
      model: string;
      timeoutMs: number;
      attemptNumber: number;
      instructions: string;
      prompt: string;
    };
    expect(contract).toMatchObject({
      happyMachineAttemptIdentity: attempt.id,
      projectWorkspace: setup.root,
      contextPath: attempt.contextPath,
      outputDirectory: attempt.outputDirectory,
      resultPath: attempt.resultPath,
      model: "test-model",
      timeoutMs: 5000,
      attemptNumber: 1,
    });
    expect(contract.instructions).toContain("Follow the task");
    expect(contract.prompt).toContain("Choose an outcome");
  });

  it("copies external and duplicate-basename inputs into the initial context", async () => {
    const setup = await project();
    const outside = await mkdtemp(path.join(os.tmpdir(), "execute-input-"));
    const internalInput = path.join(setup.root, "brief.md");
    const externalInput = path.join(outside, "brief.md");
    await writeFile(internalInput, "internal brief\n");
    await writeFile(externalInput, "external brief\n");
    const app = cli(setup.root);

    expect(
      await app.cli.run(
        [
          "execute",
          setup.workflow,
          "--input",
          internalInput,
          "--input",
          externalInput,
        ],
        setup.root,
      ),
    ).toBe(0);
    const run = await storedRun(setup.root);
    expect(run.definitionSnapshot.inputs).toMatchObject([
      {
        id: "input-0001",
        internalPath: "inputs/input-0001/brief.md",
      },
      {
        id: "input-0002",
        internalPath: "inputs/input-0002/brief.md",
      },
    ]);
    const context = await readFile(run.visits[0].contextPath, "utf8");
    expect(context.match(/^### input-0001$/gm)).toHaveLength(1);
    expect(context.match(/^### input-0002$/gm)).toHaveLength(1);
    expect(context).toContain("inputs/input-0001/brief.md");
    expect(context).toContain("inputs/input-0002/brief.md");
    expect(context).not.toContain(externalInput);
  });

  it("lets the agent read the captured input after the original changes mid-run", async () => {
    const setup = await project();
    const outside = await mkdtemp(path.join(os.tmpdir(), "execute-copy-"));
    const input = path.join(outside, "request.md");
    await writeFile(input, "content captured at run creation\n");
    await writeFile(path.join(setup.root, ".fake-original-input-path"), input);
    const app = cli(setup.root);

    expect(
      await app.cli.run(
        ["execute", setup.workflow, "--input", input],
        setup.root,
      ),
    ).toBe(0);
    await expect(readFile(input, "utf8")).resolves.toBe(
      "content changed after run creation\n",
    );
    await expect(
      readFile(path.join(setup.root, ".fake-agent-input-content"), "utf8"),
    ).resolves.toBe("content captured at run creation\n");
  });

  it.each([
    ["missing", "missing.md"],
    ["non-Markdown", "notes.txt"],
    ["nonregular", "folder.md"],
  ])("rejects a %s input before allocating a run", async (_label, name) => {
    const setup = await project();
    const input = path.join(setup.root, name);
    if (name.endsWith(".txt")) await writeFile(input, "not Markdown\n");
    if (name === "folder.md") await mkdir(input);
    const app = cli(setup.root);
    expect(
      await app.cli.run(
        ["execute", setup.workflow, "--input", input],
        setup.root,
      ),
    ).toBe(1);
    expect(app.stdout).toEqual([]);
    await expect(
      readFile(path.join(setup.root, ".happy-machine", "runs")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(setup.root, ".fake-orca-calls.jsonl")),
    ).rejects.toThrow();
  });

  it("rejects an unreadable input before allocating a run", async () => {
    const setup = await project();
    const input = path.join(setup.root, "private.md");
    await writeFile(input, "private\n");
    await chmod(input, 0o000);
    try {
      const app = cli(setup.root);
      expect(
        await app.cli.run(
          ["execute", setup.workflow, "--input", input],
          setup.root,
        ),
      ).toBe(1);
      expect(app.stdout).toEqual([]);
      await expect(
        readFile(path.join(setup.root, ".happy-machine", "runs")),
      ).rejects.toThrow();
    } finally {
      await chmod(input, 0o600);
    }
  });

  it("rejects an implicit external definition path before creating a run", async () => {
    const setup = await project();
    const outside = path.join(setup.root, "..", "outside-agent.md");
    await writeFile(outside, "# Outside agent\n");
    await writeFile(
      path.join(setup.root, "happy-machine.yaml"),
      [
        "version: 1",
        "agents:",
        "  worker:",
        "    instructions: ../outside-agent.md",
        "    model: test-model",
        "",
      ].join("\n"),
    );
    const app = cli(setup.root);
    expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(1);
    expect(app.stdout).toEqual([]);
    await expect(
      readFile(path.join(setup.root, ".happy-machine", "runs")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(setup.root, ".fake-orca-calls.jsonl")),
    ).rejects.toThrow();
  });

  it.each([
    ["execute"],
    ["execute", "workflow.yaml", "--input"],
    ["execute", "workflow.yaml", "--unknown", "value"],
    ["execute", "workflow.yaml", "extra.yaml"],
  ])("rejects malformed execute arguments: %j", async (...argv) => {
    const app = cli();
    expect(await app.cli.run(argv, "/project")).toBe(1);
    expect(app.stderr).toEqual([
      "Usage: happy-machine execute WORKFLOW_PATH [--input DOCUMENT.md ...]",
    ]);
  });

  it("snapshots prompt files, overrides, policies, and later definition edits", async () => {
    const setup = await project();
    await mkdir(path.join(setup.root, "prompts"));
    await writeFile(
      path.join(setup.root, "prompts", "review.md"),
      "# File prompt\n",
    );
    await writeFile(
      setup.workflow,
      [
        "version: 1",
        "id: one-state",
        "initial_state: review",
        "policies:",
        "  max_attempts: 6",
        "states:",
        "  review:",
        "    type: agent",
        "    agent: worker",
        "    model: override-model",
        "    prompt_file: prompts/review.md",
        "    outcomes:",
        "      approved: $succeeded",
        "      rejected: $failed",
        "",
      ].join("\n"),
    );
    const app = cli(setup.root);
    expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(0);
    const first = await storedRunById(setup.root, "run_id-1");
    const firstManifest = await readFile(
      first.definitionSnapshot.manifestPath,
      "utf8",
    );
    const firstEffective = await readFile(
      path.join(
        first.definitionSnapshot.directory,
        "definition",
        "effective.json",
      ),
      "utf8",
    );
    const parsedManifest = parseJson(firstManifest) as {
      artifacts: Array<{ kind: string; internalPath: string }>;
    };
    const promptArtifact = parsedManifest.artifacts.find(
      (artifact) => artifact.kind === "prompt_file",
    )!;
    await expect(
      readFile(
        path.join(
          first.definitionSnapshot.directory,
          ...promptArtifact.internalPath.split("/"),
        ),
        "utf8",
      ),
    ).resolves.toBe("# File prompt\n");
    expect(firstEffective).toContain('"model": "override-model"');
    expect(firstEffective).toContain('"maxAttempts": 6');
    expect(firstEffective).toContain("# File prompt");

    await writeFile(
      path.join(setup.root, "agents", "worker.md"),
      "# Edited instructions\n",
    );
    await writeFile(
      path.join(setup.root, "happy-machine.yaml"),
      (await readFile(path.join(setup.root, "happy-machine.yaml"), "utf8"))
        .replace("test-model", "new-default-model")
        .replace("attempt_timeout: 5s", "attempt_timeout: 9s"),
    );
    await writeFile(
      path.join(setup.root, "prompts", "review.md"),
      "# Edited prompt\n",
    );
    await writeFile(
      setup.workflow,
      (await readFile(setup.workflow, "utf8")).replace(
        "override-model",
        "new-model",
      ),
    );
    expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(0);
    const second = await storedRunById(setup.root, "run_id-2");
    expect(second.definitionSnapshot.identity).not.toBe(
      first.definitionSnapshot.identity,
    );
    await expect(
      readFile(first.definitionSnapshot.manifestPath, "utf8"),
    ).resolves.toBe(firstManifest);
    await expect(
      readFile(
        path.join(
          first.definitionSnapshot.directory,
          "definition",
          "effective.json",
        ),
        "utf8",
      ),
    ).resolves.toBe(firstEffective);
    const secondEffective = await readFile(
      path.join(
        second.definitionSnapshot.directory,
        "definition",
        "effective.json",
      ),
      "utf8",
    );
    expect(secondEffective).toContain('"model": "new-model"');
    expect(secondEffective).toContain('"model": "new-default-model"');
    expect(secondEffective).toContain('"attemptTimeoutMs": 9000');
    expect(secondEffective).toContain("# Edited instructions");
    expect(secondEffective).toContain("# Edited prompt");
  });

  it("does not persist a sentinel environment secret", async () => {
    const setup = await project();
    const sentinel = "SECRET_SENTINEL_7c29030f";
    const previous = process.env.HAPPY_MACHINE_TEST_SECRET;
    process.env.HAPPY_MACHINE_TEST_SECRET = sentinel;
    try {
      const app = cli(setup.root);
      expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(
        0,
      );
      const persisted = await allFileContents(
        path.join(setup.root, ".happy-machine", "runs", "run_id-1"),
      );
      const contract = await readFile(
        path.join(setup.root, ".fake-contract.json"),
        "utf8",
      );
      expect(`${persisted}\n${contract}`).not.toContain(sentinel);
    } finally {
      if (previous === undefined) delete process.env.HAPPY_MACHINE_TEST_SECRET;
      else process.env.HAPPY_MACHINE_TEST_SECRET = previous;
    }
  });
});
