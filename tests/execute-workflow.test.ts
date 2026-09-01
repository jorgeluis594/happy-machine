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
import { CancelWorkflow } from "../src/application/use-cases/cancel-workflow.js";
import { RecoverWorkflow } from "../src/application/use-cases/recover-workflow.js";
import { InspectRuns } from "../src/application/use-cases/inspect-runs.js";
import type {
  NormalVisitRecord,
  RunRecord,
} from "../src/domain/execution/run.js";
import { Cli } from "../src/infrastructure/inbound/cli/cli.js";
import { FilesystemProjectDefinitions } from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";
import { FilesystemRunRepository } from "../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";
import { OrcaTaskExecutor } from "../src/infrastructure/outbound/task-executor/orca/orca-task-executor.js";
import type { ProjectDefinitions } from "../src/ports/project-definitions.js";
import type { RunRepository } from "../src/ports/run-repository.js";
import type { TaskExecutor } from "../src/ports/task-executor.js";

const fixture = path.resolve("tests/fixtures/fake-orca.mjs");
const noStartupDelay = () => Promise.resolve();
const temporaryDirectories: string[] = [];

function normalVisit(run: RunRecord, index = 0): NormalVisitRecord {
  const visit = run.visits[index];
  if (!visit || visit.type !== "agent") throw new Error("expected agent visit");
  return visit;
}

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
      "    runtime: codex",
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

async function routingProject(
  results: Record<
    string,
    {
      outcome: string;
      error?: unknown;
      documents?: Array<{ path: string; content: string }>;
      workspaceEdits?: Array<{ path: string; content: string }>;
    }
  >,
  states = `  review:
    type: agent
    agent: worker
    prompt: Review
    outcomes:
      approved: publish
      needs_revision: revise
  revise:
    type: agent
    agent: worker
    prompt: Revise
    outcomes:
      completed: publish
  publish:
    type: agent
    agent: worker
    prompt: Publish
    outcomes:
      published: $succeeded`,
): Promise<{ root: string; workflow: string }> {
  const setup = await project();
  await writeFile(
    setup.workflow,
    `version: 1
id: routed
initial_state: review
states:
${states}
`,
  );
  await writeFile(
    path.join(setup.root, ".fake-results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  return setup;
}

function cli(projectRoot?: string) {
  let id = 0;
  const repository = new FilesystemRunRepository();
  const executor = new OrcaTaskExecutor(fixture, undefined, noStartupDelay);
  const now = () => new Date("2026-08-11T12:00:00.000Z");
  const useCase = new ExecuteWorkflow(
    new FilesystemProjectDefinitions(),
    repository,
    executor,
    now,
    () => `id-${++id}`,
    () => new Promise(() => {}),
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    cli: new Cli(
      useCase,
      new RecoverWorkflow(repository, executor, now, () => Promise.resolve()),
      new CancelWorkflow(repository, executor, now, () => Promise.resolve()),
      new InspectRuns(repository, now),
      {
        stdout: (line) => {
          stdout.push(line);
          if (projectRoot && line.startsWith("run_"))
            writeFileSync(path.join(projectRoot, ".run-id-printed"), line);
        },
        stderr: (line) => stderr.push(line),
      },
    ),
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
      stageDocuments: () => {
        calls.push("runs.stageDocuments");
        return Promise.reject(new Error("must not commit"));
      },
    } as RunRepository;
    const executor = {
      execute: () => {
        calls.push("executor.execute");
        return Promise.reject(new Error("must not execute"));
      },
      cancel: () => {
        calls.push("executor.cancel");
        return Promise.reject(new Error("must not cancel"));
      },
      reconcile: () => {
        calls.push("executor.reconcile");
        return Promise.reject(new Error("must not reconcile"));
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
      () => {
        calls.push("wait");
        return new Promise(() => {});
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

  it.each([
    [
      "approved",
      { review: { outcome: "approved" }, publish: { outcome: "published" } },
      ["review", "publish"],
      ["publish", "$succeeded"],
    ],
    [
      "needs_revision",
      {
        review: { outcome: "needs_revision" },
        revise: { outcome: "completed" },
        publish: { outcome: "published" },
      },
      ["review", "revise", "publish"],
      ["revise", "publish", "$succeeded"],
    ],
  ])(
    "executes only the %s branch through a three-state workflow",
    async (_branch, results, expectedStates, expectedTargets) => {
      const setup = await routingProject(results);
      const app = cli(setup.root);
      expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(
        0,
      );
      const run = await storedRun(setup.root);
      expect(run.visits.map((visit) => visit.stateId)).toEqual(expectedStates);
      expect(run.visits.map((visit) => visit.target)).toEqual(expectedTargets);
      expect(run.status).toBe("succeeded");
    },
  );

  it("treats a rejected business result as successful when configured that way", async () => {
    const setup = await routingProject(
      { review: { outcome: "rejected" } },
      `  review:
    type: agent
    agent: worker
    prompt: Decide
    outcomes:
      rejected: $succeeded`,
    );
    const app = cli(setup.root);
    expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(0);
    const run = await storedRun(setup.root);
    expect(run).toMatchObject({
      status: "succeeded",
      terminalTarget: "$succeeded",
    });
    expect(run.visits.at(-1)?.outcome).toBe("rejected");
  });

  it.each(["succeeded", "failed"])(
    "treats %s as an ordinary outcome name in a normal state",
    async (ordinaryOutcome) => {
      const setup = await routingProject(
        {
          review: { outcome: ordinaryOutcome },
          followup: { outcome: "done" },
        },
        `  review:
    type: agent
    agent: worker
    prompt: Decide
    outcomes:
      succeeded: followup
      failed: followup
  followup:
    type: agent
    agent: worker
    prompt: Follow up
    outcomes:
      done: $succeeded`,
      );
      const app = cli(setup.root);
      expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(
        0,
      );
      const run = await storedRun(setup.root);
      expect(run.visits.map((visit) => visit.stateId)).toEqual([
        "review",
        "followup",
      ]);
      expect(run.visits[0]).toMatchObject({
        outcome: ordinaryOutcome,
        target: "followup",
      });
    },
  );

  it("exchanges multiple immutable documents, preserves repeated basenames, and snapshots each visit context", async () => {
    const setup = await routingProject({
      review: {
        outcome: "needs_revision",
        documents: [
          { path: "report.md", content: "review report says publish\n" },
          { path: "notes.md", content: "review notes\n" },
        ],
        workspaceEdits: [
          { path: "undeclared-source.ts", content: "workspace only\n" },
        ],
      },
      revise: {
        outcome: "completed",
        documents: [
          { path: "report.md", content: "revised report says rejected\n" },
        ],
      },
      publish: { outcome: "published" },
    });
    const app = cli(setup.root);
    expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(0);
    const run = await storedRun(setup.root);

    expect(run.documents).toHaveLength(3);
    expect(run.documents.map((document) => document.name)).toEqual([
      "report.md",
      "notes.md",
      "report.md",
    ]);
    expect(
      new Set(run.documents.map((document) => document.internalPath)).size,
    ).toBe(3);
    for (const document of run.documents) {
      expect(document.internalPath).toBe(
        `states/${document.stateId}/visits/${document.visitNumber}/tasks/${document.taskId}/documents/${document.name}`,
      );
      expect(document.sha256).toMatch(/^[a-f0-9]{64}$/);
      await expect(
        readFile(document.durablePath, "utf8"),
      ).resolves.toBeTruthy();
    }
    expect(run.documents[0].durablePath).not.toBe(run.documents[2].durablePath);

    const [reviewContext, reviseContext, publishContext] = await Promise.all(
      run.visits.map((visit) => readFile(visit.contextPath, "utf8")),
    );
    expect(reviewContext).not.toContain("review-task/documents/report.md");
    expect(reviseContext).toContain(
      "states/review/visits/1/tasks/review-task/documents/report.md",
    );
    expect(reviseContext).toContain(
      "states/review/visits/1/tasks/review-task/documents/notes.md",
    );
    expect(publishContext).toContain(
      "states/review/visits/1/tasks/review-task/documents/report.md",
    );
    expect(publishContext).toContain(
      "states/revise/visits/1/tasks/revise-task/documents/report.md",
    );
    expect(publishContext.match(/^### report\.md$/gm)).toHaveLength(2);
    expect(publishContext).not.toContain("undeclared-source.ts");
    expect(run.visits.map((visit) => visit.contextPath)).toEqual([
      expect.stringContaining("states/review/visits/1/context.md"),
      expect.stringContaining("states/revise/visits/1/context.md"),
      expect.stringContaining("states/publish/visits/1/context.md"),
    ]);
    expect(await readFile(run.visits[0].contextPath, "utf8")).toBe(
      reviewContext,
    );
    expect(run.visits[0].outcome).toBe("needs_revision");
  });

  it("does not launch the next state when the committed transition cannot be persisted", async () => {
    const setup = await routingProject({
      review: {
        outcome: "approved",
        documents: [{ path: "audit.md", content: "staged only\n" }],
      },
      publish: { outcome: "published" },
    });
    const filesystem = new FilesystemRunRepository();
    let blocked = false;
    const runs: RunRepository = {
      createSnapshot: (request) => filesystem.createSnapshot(request),
      prepareVisitContext: (run) => filesystem.prepareVisitContext(run),
      prepareAttempt: (run, visit, task, attemptNumber) =>
        filesystem.prepareAttempt(run, visit, task, attemptNumber),
      readResult: (resultPath, outputDirectory, outcomes) =>
        filesystem.readResult(resultPath, outputDirectory, outcomes),
      stageDocuments: (run, visit, task, outputDirectory, names) =>
        filesystem.stageDocuments(run, visit, task, outputDirectory, names),
      save: async (run) => {
        if (!blocked && run.visits[0]?.target === "publish") {
          blocked = true;
          await writeFile(
            path.join(
              run.projectRoot,
              ".happy-machine",
              "runs",
              run.id,
              "run.json.tmp",
            ),
            "{interrupted logical commit",
          );
          throw new Error("blocked transition persistence");
        }
        return filesystem.save(run);
      },
    };
    let id = 0;
    const useCase = new ExecuteWorkflow(
      new FilesystemProjectDefinitions(),
      runs,
      new OrcaTaskExecutor(fixture, undefined, noStartupDelay),
      () => new Date("2026-08-11T12:00:00.000Z"),
      () => `blocked-${++id}`,
      () => new Promise(() => {}),
    );
    await expect(
      useCase.execute({
        workflowPath: setup.workflow,
        currentDirectory: setup.root,
        onRunAllocated: (runId) =>
          writeFileSync(path.join(setup.root, ".run-id-printed"), runId),
      }),
    ).rejects.toThrow("blocked transition persistence");
    const run = await storedRun(setup.root);
    expect(run.visits.map((visit) => visit.stateId)).toEqual(["review"]);
    expect(run.status).toBe("failed");
    expect(run.documents).toEqual([]);
    expect(run.visits[0]).not.toHaveProperty("outcome");
    expect(run.visits[0]).not.toHaveProperty("target");
    expect(normalVisit(run).task.attempts[0].documents).toEqual([]);
    expect(await readFile(run.visits[0].contextPath, "utf8")).not.toContain(
      "audit.md",
    );
    await expect(
      readFile(
        path.join(
          setup.root,
          ".happy-machine",
          "runs",
          run.id,
          "states",
          "review",
          "visits",
          "1",
          "tasks",
          "review-task",
          "documents",
          "audit.md",
        ),
        "utf8",
      ),
    ).resolves.toBe("staged only\n");
    const calls = (
      await readFile(path.join(setup.root, ".fake-orca-calls.jsonl"), "utf8")
    )
      .trim()
      .split("\n");
    expect(calls).toHaveLength(2);
  });

  it("fails an unknown outcome after one attempt without promoting output or workspace edits", async () => {
    const setup = await routingProject(
      {
        review: {
          outcome: "uncertain",
          documents: [{ path: "audit.md", content: "audit only\n" }],
          workspaceEdits: [
            { path: "source-change.ts", content: "preserved workspace edit\n" },
          ],
        },
      },
      `  review:
    type: agent
    agent: worker
    prompt: Decide
    max_attempts: 1
    outcomes:
      approved: $succeeded`,
    );
    const app = cli(setup.root);
    expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(1);
    const stored = await storedRun(setup.root);
    expect(stored.status).toBe("failed");
    expect(stored.documents).toEqual([]);
    expect(stored.visits[0]).not.toHaveProperty("outcome");
    expect(stored.visits[0]).not.toHaveProperty("target");
    expect(normalVisit(stored).task.attempts).toHaveLength(1);
    expect(normalVisit(stored).task.attempts[0]).toMatchObject({
      status: "failed",
      documents: [],
    });
    expect(stored.events.map((event) => event.type)).not.toContain(
      "transition_committed",
    );
    await expect(
      readFile(path.join(setup.root, "source-change.ts"), "utf8"),
    ).resolves.toBe("preserved workspace edit\n");
    expect(await readFile(stored.visits[0].contextPath, "utf8")).not.toContain(
      "audit.md",
    );
  });

  it("retains result error as diagnostic data while routing only by outcome", async () => {
    const setup = await routingProject({
      review: {
        outcome: "approved",
        error: { code: "quality-warning", suggestedOutcome: "rejected" },
      },
      publish: { outcome: "published" },
    });
    const app = cli(setup.root);
    expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(0);
    const stored = await storedRun(setup.root);
    expect(stored.visits.map((visit) => visit.stateId)).toEqual([
      "review",
      "publish",
    ]);
    expect(normalVisit(stored).task.attempts[0].error).toEqual({
      code: "quality-warning",
      suggestedOutcome: "rejected",
    });
  });

  it("executes every later state from its snapshotted overrides despite workspace definition edits", async () => {
    const setup = await routingProject(
      {
        review: {
          outcome: "approved",
          workspaceEdits: [
            {
              path: "workflows/one.yaml",
              content: "the live workflow is no longer valid\n",
            },
          ],
        },
        publish: { outcome: "published" },
      },
      `  review:
    type: agent
    agent: worker
    prompt: Review snapshot prompt
    outcomes:
      approved: publish
  publish:
    type: agent
    agent: worker
    prompt: Publish snapshot prompt
    attempt_timeout: 2s
    outcomes:
      published: $succeeded`,
    );
    const app = cli(setup.root);
    expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(0);
    const contracts = (
      await readFile(path.join(setup.root, ".fake-contracts.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          parseJson(line) as {
            instructions: string;
            timeoutMs: number;
          },
      );
    expect(contracts).toMatchObject([{ timeoutMs: 5000 }, { timeoutMs: 2000 }]);
    const prompts = (
      await readFile(path.join(setup.root, ".fake-prompts.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => parseJson(line));
    expect(prompts[0]).toMatch(/^Review snapshot prompt\n\n---\n/);
    expect(prompts[1]).toMatch(/^Publish snapshot prompt\n\n---\n/);
    expect(contracts[0].instructions).toContain('- "approved"');
    expect(contracts[0].instructions).not.toContain("publish");
    expect(contracts[1].instructions).toContain('- "published"');
    expect(contracts[1].instructions).not.toContain("$succeeded");
  });

  it("uses only result.json for routing and durably attributes the launch, logs, and outcome", async () => {
    const setup = await project("approved");
    const app = cli(setup.root);
    expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(0);
    const run = await storedRun(setup.root);
    const attempt = normalVisit(run).task.attempts[0];
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
        executionId: "terminal-1",
        terminalHandle: "terminal-1",
      },
    });
    expect(attempt.logs.stdout).toContain('"handle":"terminal-1"');
    expect(attempt.logs.stderr).toBe("");
    expect(run.events.map((event: { type: string }) => event.type)).toEqual([
      "run_created",
      "controller_lease_acquired",
      "limit_evaluated",
      "limit_evaluated",
      "state_entered",
      "task_queued",
      "limit_evaluated",
      "attempt_launching",
      "task_scheduled",
      "attempt_started",
      "attempt_succeeded",
      "limit_evaluated",
      "limit_evaluated",
      "transition_committed",
      "run_terminal",
      "controller_lease_released",
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
      timeoutMs: 5000,
      attemptNumber: 1,
    });
    expect(contract.instructions).toContain("Follow the task");
    expect(contract.prompt).toMatch(
      /^Choose an outcome and write the structured result\.\n\n---\n/,
    );
  });

  it("does not consume Orca orchestration messages", async () => {
    const setup = await project("approved");
    await writeFile(
      path.join(setup.root, ".fake-check-sequence.json"),
      JSON.stringify([
        {
          messages: [
            { type: "question", questionId: "q-1", message: "Approve?" },
          ],
        },
        {
          messages: [
            {
              type: "escalation",
              escalationId: "e-1",
              reason: "External review",
            },
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
    const app = cli(setup.root);

    expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(0);
    const run = await storedRun(setup.root);
    const attempt = normalVisit(run).task.attempts[0];

    expect(run.status).toBe("succeeded");
    expect(attempt.outcome).toBe("approved");
    expect(attempt.externalEvents).toBeUndefined();
    expect(run.events.map((event) => event.type)).not.toEqual(
      expect.arrayContaining([
        "orca_question_observed",
        "orca_escalation_observed",
        "orca_question_resolved",
      ]),
    );
    expect(run.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["attempt_succeeded", "transition_committed"]),
    );
  });

  it("exposes read-only status and history commands with successful exit codes", async () => {
    const setup = await project("approved");
    const app = cli(setup.root);
    expect(await app.cli.run(["execute", setup.workflow], setup.root)).toBe(0);
    const runId = app.stdout[0];

    expect(await app.cli.run(["status", runId], setup.root)).toBe(0);
    expect(app.stdout.at(-1)).toContain(`Run: ${runId}`);
    expect(app.stdout.at(-1)).toContain("Status: succeeded");
    expect(app.stdout.at(-1)).toContain(
      `run=${runId} state=review visit=1 task=review-task attempt=1`,
    );
    expect(await app.cli.run(["history", runId], setup.root)).toBe(0);
    expect(app.stdout.at(-1)).toContain("Events:");
    expect(await app.cli.run(["history"], setup.root)).toBe(0);
    expect(app.stdout.at(-1)).toContain("Runs (newest first):");
    expect(await app.cli.run(["status", "unknown-run"], setup.root)).toBe(1);
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
        "    runtime: codex",
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
      "Invalid arguments for command: execute\nTry 'happy-machine help execute' for more information.",
    ]);
  });

  it("snapshots runtimes, prompt files, policies, and later definition edits", async () => {
    const setup = await project();
    await writeFile(
      path.join(setup.root, "happy-machine.yaml"),
      (
        await readFile(path.join(setup.root, "happy-machine.yaml"), "utf8")
      ).replace("runtime: codex", "runtime: opencode"),
    );
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
    expect(firstEffective).toContain('"runtime": "opencode"');
    expect(firstEffective).not.toContain('"model"');
    expect(firstEffective).toContain('"maxAttempts": 6');
    expect(firstEffective).toContain("# File prompt");

    await writeFile(
      path.join(setup.root, "agents", "worker.md"),
      "# Edited instructions\n",
    );
    await writeFile(
      path.join(setup.root, "happy-machine.yaml"),
      (await readFile(path.join(setup.root, "happy-machine.yaml"), "utf8"))
        .replace("runtime: opencode", "runtime: codex")
        .replace("attempt_timeout: 5s", "attempt_timeout: 9s"),
    );
    await writeFile(
      path.join(setup.root, "prompts", "review.md"),
      "# Edited prompt\n",
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
    expect(secondEffective).toContain('"runtime": "codex"');
    expect(secondEffective).not.toContain('"model"');
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
