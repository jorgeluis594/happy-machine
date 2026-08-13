import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CancelWorkflow } from "../src/application/use-cases/cancel-workflow.js";
import { ExecuteWorkflow } from "../src/application/use-cases/execute-workflow.js";
import { InspectRuns } from "../src/application/use-cases/inspect-runs.js";
import { RecoverWorkflow } from "../src/application/use-cases/recover-workflow.js";
import type {
  AttemptRecord,
  ExecutorReferences,
  ParallelTaskRecord,
  ParallelVisitRecord,
  RunRecord,
  RunStatus,
} from "../src/domain/execution/run.js";
import { Cli } from "../src/infrastructure/inbound/cli/cli.js";
import { RunPresenter } from "../src/infrastructure/inbound/cli/run-presenter.js";
import { FilesystemProjectDefinitions } from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";
import { FilesystemRunRepository } from "../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";
import type {
  EffectiveExecutionDefinition,
  EffectivePolicies,
} from "../src/ports/project-definitions.js";
import {
  RunCancellationRequestedError,
  type CancellationRequestResult,
} from "../src/ports/run-repository.js";
import type {
  RecoveryObservation,
  TaskExecution,
  TaskExecutor,
} from "../src/ports/task-executor.js";

function policies(): EffectivePolicies {
  return {
    attemptTimeoutMs: 10_000,
    maxAttempts: 3,
    retryDelayMs: 1_000,
    workflowTimeoutMs: 60_000,
    maxStateVisits: 10,
    maxTransitions: 100,
    maxConcurrency: 2,
    controllerLeaseMs: 5_000,
  };
}

function definition(): EffectiveExecutionDefinition {
  const effective = policies();
  const task = (id: string) => ({
    id,
    agent: {
      id: `${id}-agent`,
      instructions: `Handle ${id}`,
      model: "test-model",
    },
    prompt: id,
    policies: effective,
  });
  return {
    workflowId: "durable-cancellation",
    executorType: "orca",
    workspaceMode: "direct",
    agents: {},
    policies: effective,
    initialState: "fan_out",
    states: {
      fan_out: {
        id: "fan_out",
        type: "parallel",
        tasks: {
          active_one: task("active_one"),
          active_two: task("active_two"),
          queued: task("queued"),
          succeeded: task("succeeded"),
          failed: task("failed"),
        },
        outcomes: { succeeded: "$succeeded", failed: "$failed" },
        policies: effective,
        effectiveMaxConcurrency: 2,
      },
    },
  };
}

const references = (identity: string): ExecutorReferences => ({
  runId: `orca-run:${identity}`,
  taskId: `orca-task:${identity}`,
  dispatchId: `orca-dispatch:${identity}`,
  terminalHandle: `orca-terminal:${identity}`,
});

function attempt(
  root: string,
  identity: string,
  status: AttemptRecord["status"],
  executor?: ExecutorReferences,
): AttemptRecord {
  const directory = path.join(root, "control", identity.replaceAll(":", "_"));
  return {
    id: identity,
    number: 1,
    startedAt: "2026-08-11T12:00:00.000Z",
    deadlineAt: "2026-08-11T12:00:10.000Z",
    status,
    controlWorkspace: directory,
    contextPath: path.join(directory, "context.md"),
    outputDirectory: path.join(directory, "output"),
    resultPath: path.join(directory, "result.json"),
    executor,
    logs: { stdout: `stdout:${identity}`, stderr: `stderr:${identity}` },
    documents: [],
  };
}

class FakeOrcaExecutor implements TaskExecutor {
  readonly recoveries: string[] = [];
  readonly cancellations: ExecutorReferences[] = [];
  readonly reconciliations: ExecutorReferences[] = [];
  readonly sequences = new Map<
    string,
    Array<"active" | "stopped" | "unknown">
  >();

  recover(
    identity: string,
    known: ExecutorReferences | undefined,
  ): Promise<RecoveryObservation> {
    this.recoveries.push(identity);
    return Promise.resolve({
      status: "active",
      references: known ?? references(identity),
      logs: { stdout: `observed:${identity}`, stderr: "" },
    });
  }

  execute(): Promise<TaskExecution> {
    throw new Error("Cancellation must never launch queued work");
  }

  cancel(external: ExecutorReferences): Promise<void> {
    this.cancellations.push(structuredClone(external));
    return Promise.resolve();
  }

  reconcile(
    external: ExecutorReferences,
  ): Promise<"active" | "stopped" | "unknown"> {
    this.reconciliations.push(structuredClone(external));
    const sequence = this.sequences.get(external.dispatchId!);
    return Promise.resolve(sequence?.shift() ?? "stopped");
  }
}

class AcceptanceFaultRepository extends FilesystemRunRepository {
  failAfterAcceptance = true;

  override async requestCancellation(
    projectRoot: string,
    runId: string,
    controllerId: string,
    requestedAt: string,
  ): Promise<CancellationRequestResult> {
    const result = await super.requestCancellation(
      projectRoot,
      runId,
      controllerId,
      requestedAt,
    );
    if (this.failAfterAcceptance && result.accepted) {
      this.failAfterAcceptance = false;
      throw new Error("fault immediately after durable acceptance");
    }
    return result;
  }
}

class ReconciliationFaultRepository extends FilesystemRunRepository {
  controlledSaves = 0;
  failOnControlledSave = 4;

  override async saveControlled(
    run: RunRecord,
    controllerId: string,
    fencingToken: number,
  ): Promise<void> {
    this.controlledSaves += 1;
    await super.saveControlled(run, controllerId, fencingToken);
    if (this.controlledSaves === this.failOnControlledSave)
      throw new Error("fault during cancellation reconciliation");
  }
}

interface Setup {
  root: string;
  repository: FilesystemRunRepository;
  run: RunRecord;
  scheduler: { run: RunRecord; fencingToken: number };
  evidence: {
    documentPath: string;
    auditPath: string;
    sourcePath: string;
    worktreePath: string;
  };
}

async function setupActiveRun(
  repository: FilesystemRunRepository = new FilesystemRunRepository(),
): Promise<Setup> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-cancel-"));
  await writeFile(path.join(root, "happy-machine.yaml"), "version: 1\n");
  const effective = definition();
  const snapshot = await repository.createSnapshot({
    runId: "run-cancel",
    projectRoot: root,
    workflowId: effective.workflowId,
    source: {
      effectiveDefinition: effective,
      artifacts: [
        {
          kind: "workflow",
          logicalId: "workflow",
          content: "durable cancellation workflow\n",
        },
      ],
      inputs: [],
    },
  });
  const documentPath = path.join(
    root,
    ".happy-machine",
    "runs",
    "run-cancel",
    "documents",
    "report.md",
  );
  const auditPath = path.join(root, "audit", "failed-output.txt");
  const sourcePath = path.join(root, "source-change.txt");
  const worktreePath = path.join(root, "managed-worktree");
  await mkdir(path.dirname(documentPath), { recursive: true });
  await mkdir(path.dirname(auditPath), { recursive: true });
  await mkdir(worktreePath);
  await writeFile(documentPath, "committed report\n");
  await writeFile(auditPath, "uncommitted failed output\n");
  await writeFile(sourcePath, "user source change\n");
  await writeFile(path.join(worktreePath, "work.txt"), "retained worktree\n");

  const activeOne = attempt(
    root,
    "run-cancel:fan_out:1:active_one:1",
    "running",
    references("run-cancel:fan_out:1:active_one:1"),
  );
  const activeTwo = attempt(
    root,
    "run-cancel:fan_out:1:active_two:1",
    "launching",
  );
  const succeeded = attempt(
    root,
    "run-cancel:fan_out:1:succeeded:1",
    "succeeded",
    references("run-cancel:fan_out:1:succeeded:1"),
  );
  succeeded.documents = [
    {
      stateId: "fan_out",
      visitNumber: 1,
      taskId: "succeeded",
      name: "report.md",
      internalPath: "documents/report.md",
      durablePath: documentPath,
      sha256: "sha256:committed-report",
    },
  ];
  const failed = attempt(
    root,
    "run-cancel:fan_out:1:failed:1",
    "failed",
    references("run-cancel:fan_out:1:failed:1"),
  );
  failed.failure = { code: "executor_failed", message: "failed evidence" };
  const task = (
    id: string,
    status: ParallelTaskRecord["status"],
    attempts: AttemptRecord[],
    workspace = root,
  ): ParallelTaskRecord => ({
    id,
    status,
    attempts,
    documents: attempts.at(-1)?.documents ?? [],
    workspace: {
      mode: workspace === root ? "direct" : "worktree",
      path: workspace,
    },
  });
  const visit: ParallelVisitRecord = {
    type: "parallel",
    stateId: "fan_out",
    number: 1,
    contextPath: path.join(root, "context.md"),
    tasks: [
      task("active_one", "running", [activeOne]),
      task("active_two", "running", [activeTwo]),
      task("queued", "queued", []),
      task("succeeded", "succeeded", [succeeded], worktreePath),
      {
        ...task("failed", "failed", [failed]),
        failure: failed.failure,
      },
    ],
  };
  const run: RunRecord = {
    id: "run-cancel",
    workflowId: effective.workflowId,
    workflowPath: path.join(root, "workflow.yaml"),
    projectRoot: root,
    definitionSnapshot: snapshot.record,
    status: "running",
    controllerStatus: "detached",
    createdAt: "2026-08-11T12:00:00.000Z",
    deadlineAt: "2026-08-11T12:01:00.000Z",
    transitionCount: 0,
    visits: [visit],
    documents: [...succeeded.documents],
    events: [
      {
        sequence: 1,
        type: "run_created",
        at: "2026-08-11T12:00:00.000Z",
        data: { definitionSnapshotIdentity: snapshot.record.identity },
      },
      {
        sequence: 2,
        type: "document_committed",
        at: "2026-08-11T12:00:01.000Z",
        data: { internalPath: "documents/report.md" },
      },
    ],
  };
  await repository.save(run);
  const scheduler = await repository.acquireControl(
    root,
    run.id,
    "scheduler",
    "2026-08-11T12:00:02.000Z",
  );
  return {
    root,
    repository,
    run: scheduler.run,
    scheduler,
    evidence: { documentPath, auditPath, sourcePath, worktreePath },
  };
}

function clock(): () => Date {
  let tick = 0;
  return () => new Date(Date.parse("2026-08-11T12:00:03.000Z") + tick++);
}

function canceler(
  repository: FilesystemRunRepository,
  executor: TaskExecutor,
  now = clock(),
): CancelWorkflow {
  return new CancelWorkflow(repository, executor, now, () => Promise.resolve());
}

function activeVisit(run: RunRecord): ParallelVisitRecord {
  const visit = run.visits[0];
  if (visit?.type !== "parallel") throw new Error("Expected parallel visit");
  return visit;
}

describe("durable run cancellation", () => {
  it("durably fences scheduling, cancels every active Orca execution, and preserves all evidence", async () => {
    const setup = await setupActiveRun();
    const executor = new FakeOrcaExecutor();
    const beforeSnapshot = structuredClone(setup.run.definitionSnapshot);
    const beforeDocuments = structuredClone(setup.run.documents);
    const beforeEvents = structuredClone(setup.run.events);
    const beforeTransitions = setup.run.events.filter(
      (event) => event.type === "transition_committed",
    );

    const canceled = await canceler(setup.repository, executor).cancel({
      currentDirectory: setup.root,
      runId: setup.run.id,
      controllerId: "cancel-controller",
    });

    expect(canceled).toMatchObject({
      status: "canceled",
      controllerStatus: "detached",
    });
    expect(typeof canceled.cancellation?.requestedAt).toBe("string");
    expect(typeof canceled.cancellation?.completedAt).toBe("string");
    expect(canceled).not.toHaveProperty("failure");
    expect(canceled).not.toHaveProperty("terminalTarget");
    expect(executor.cancellations.map((item) => item.dispatchId)).toEqual([
      references("run-cancel:fan_out:1:active_one:1").dispatchId,
      references("run-cancel:fan_out:1:active_two:1").dispatchId,
    ]);
    const visit = activeVisit(canceled);
    expect(visit.tasks.map(({ id, status }) => [id, status])).toEqual([
      ["active_one", "canceled"],
      ["active_two", "canceled"],
      ["queued", "queued"],
      ["succeeded", "succeeded"],
      ["failed", "failed"],
    ]);
    expect(visit.tasks.find((task) => task.id === "queued")?.attempts).toEqual(
      [],
    );
    for (const id of ["active_one", "active_two"]) {
      const canceledAttempt = visit.tasks.find((task) => task.id === id)
        ?.attempts[0];
      expect(canceledAttempt).toMatchObject({
        status: "canceled",
        externalStatus: "stopped",
      });
      expect(canceledAttempt?.executor?.dispatchId).toBe(
        references(`run-cancel:fan_out:1:${id}:1`).dispatchId,
      );
      expect(
        typeof canceledAttempt?.reconciliation?.cancellationRequestedAt,
      ).toBe("string");
      expect(typeof canceledAttempt?.reconciliation?.confirmedStoppedAt).toBe(
        "string",
      );
    }
    expect(
      visit.tasks.find((task) => task.id === "active_one")?.attempts[0].logs,
    ).toEqual({
      stdout: "stdout:run-cancel:fan_out:1:active_one:1",
      stderr: "stderr:run-cancel:fan_out:1:active_one:1",
    });
    expect(canceled.documents).toEqual(beforeDocuments);
    expect(canceled.definitionSnapshot).toEqual(beforeSnapshot);
    expect(canceled.events.slice(0, beforeEvents.length)).toEqual(beforeEvents);
    expect(
      canceled.events.filter((event) => event.type === "transition_committed"),
    ).toEqual(beforeTransitions);
    expect(visit.outcome).toBeUndefined();
    expect(visit.target).toBeUndefined();
    expect(await readFile(setup.evidence.documentPath, "utf8")).toBe(
      "committed report\n",
    );
    expect(await readFile(setup.evidence.auditPath, "utf8")).toBe(
      "uncommitted failed output\n",
    );
    expect(await readFile(setup.evidence.sourcePath, "utf8")).toBe(
      "user source change\n",
    );
    expect(
      await readFile(
        path.join(setup.evidence.worktreePath, "work.txt"),
        "utf8",
      ),
    ).toBe("retained worktree\n");
    expect(
      visit.tasks.find((task) => task.id === "failed")?.attempts[0].logs,
    ).toEqual({
      stdout: "stdout:run-cancel:fan_out:1:failed:1",
      stderr: "stderr:run-cancel:fan_out:1:failed:1",
    });
    expect(canceled.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "run_cancellation_requested",
        "run_status_changed",
        "attempt_cancellation_requested",
        "attempt_reconciled",
        "run_cancellation_completed",
        "run_terminal",
      ]),
    );
    await expect(
      setup.repository.saveControlled(
        setup.scheduler.run,
        "scheduler",
        setup.scheduler.fencingToken,
      ),
    ).rejects.toBeInstanceOf(RunCancellationRequestedError);
  });

  it("persists acceptance before any external action and a later cancel continues after an immediate crash", async () => {
    const repository = new AcceptanceFaultRepository();
    const setup = await setupActiveRun(repository);
    const executor = new FakeOrcaExecutor();
    const first = canceler(repository, executor);

    await expect(
      first.cancel({
        currentDirectory: setup.root,
        runId: setup.run.id,
        controllerId: "crashing-canceler",
      }),
    ).rejects.toThrow("fault immediately after durable acceptance");

    const accepted = (await repository.load(setup.root, setup.run.id)).run;
    expect(accepted.status).toBe("canceling");
    expect(accepted.cancellation?.requestedAt).toEqual(expect.any(String));
    expect(executor.cancellations).toHaveLength(0);
    const cancellationToken = accepted.controllerLease?.fencingToken;
    await expect(
      repository.acquireControl(
        setup.root,
        setup.run.id,
        "racing-resume-controller",
        "2026-08-11T12:00:03.500Z",
      ),
    ).rejects.toBeInstanceOf(RunCancellationRequestedError);
    expect(
      (await repository.load(setup.root, setup.run.id)).run.controllerLease
        ?.fencingToken,
    ).toBe(cancellationToken);
    await expect(
      setup.repository.saveControlled(
        setup.scheduler.run,
        "scheduler",
        setup.scheduler.fencingToken,
      ),
    ).rejects.toBeInstanceOf(RunCancellationRequestedError);
    await expect(
      new RecoverWorkflow(repository, executor, clock(), () =>
        Promise.resolve(),
      ).recover({
        projectRoot: setup.root,
        runId: setup.run.id,
        controllerId: "must-not-resume",
      }),
    ).rejects.toMatchObject({ code: "run_not_resumable" });

    const completed = await canceler(repository, executor).cancel({
      currentDirectory: setup.root,
      runId: setup.run.id,
      controllerId: "replacement-canceler",
    });
    expect(completed.status).toBe("canceled");
    expect(executor.cancellations).toHaveLength(2);
    expect(
      completed.events.filter(
        (event) => event.type === "run_cancellation_requested",
      ),
    ).toHaveLength(1);
  });

  it("continues interrupted reconciliation without reviving tasks or duplicating Orca cancellation requests", async () => {
    const repository = new ReconciliationFaultRepository();
    const setup = await setupActiveRun(repository);
    const executor = new FakeOrcaExecutor();
    const firstDispatch = references(
      "run-cancel:fan_out:1:active_one:1",
    ).dispatchId!;
    executor.sequences.set(firstDispatch, ["active", "stopped"]);

    await expect(
      canceler(repository, executor).cancel({
        currentDirectory: setup.root,
        runId: setup.run.id,
        controllerId: "first-canceler",
      }),
    ).rejects.toThrow("fault during cancellation reconciliation");

    const interrupted = (await repository.load(setup.root, setup.run.id)).run;
    expect(interrupted.status).toBe("canceling");
    expect(executor.cancellations).toHaveLength(1);
    const visible = new RunPresenter().status(
      await new InspectRuns(repository, clock()).status(
        setup.root,
        setup.run.id,
      ),
    );
    expect(visible).toContain("Status: canceling");
    expect(visible).toContain("cancellation=requested=");
    expect(visible).toContain("status=active");

    const completed = await canceler(repository, executor).cancel({
      currentDirectory: setup.root,
      runId: setup.run.id,
      controllerId: "second-canceler",
    });
    expect(completed.status).toBe("canceled");
    expect(executor.cancellations).toHaveLength(2);
    expect(
      executor.cancellations.filter(
        (item) => item.dispatchId === firstDispatch,
      ),
    ).toHaveLength(1);
    expect(
      activeVisit(completed).tasks.find((task) => task.id === "queued"),
    ).toMatchObject({ status: "queued", attempts: [] });
  });

  it("continues after a crash between durable per-execution intent and the Orca stop command", async () => {
    const repository = new ReconciliationFaultRepository();
    repository.failOnControlledSave = 2;
    const setup = await setupActiveRun(repository);
    const executor = new FakeOrcaExecutor();

    await expect(
      canceler(repository, executor).cancel({
        currentDirectory: setup.root,
        runId: setup.run.id,
        controllerId: "pre-command-canceler",
      }),
    ).rejects.toThrow("fault during cancellation reconciliation");
    expect(executor.cancellations).toHaveLength(0);
    const interrupted = (await repository.load(setup.root, setup.run.id)).run;
    expect(interrupted.status).toBe("canceling");
    expect(
      typeof activeVisit(interrupted).tasks[0].attempts[0].reconciliation
        ?.cancellationRequestedAt,
    ).toBe("string");
    expect(
      activeVisit(interrupted).tasks[0].attempts[0].reconciliation,
    ).not.toHaveProperty("cancellationCommandCompletedAt");

    const completed = await canceler(repository, executor).cancel({
      currentDirectory: setup.root,
      runId: setup.run.id,
      controllerId: "post-command-canceler",
    });
    expect(completed.status).toBe("canceled");
    expect(executor.cancellations.map((item) => item.dispatchId)).toEqual([
      references("run-cancel:fan_out:1:active_one:1").dispatchId,
      references("run-cancel:fan_out:1:active_two:1").dispatchId,
    ]);
  });

  it("records irreconcilable external uncertainty safely before terminal cancellation", async () => {
    const setup = await setupActiveRun();
    const executor = new FakeOrcaExecutor();
    const uncertainDispatch = references(
      "run-cancel:fan_out:1:active_one:1",
    ).dispatchId!;
    executor.sequences.set(uncertainDispatch, ["unknown"]);

    const completed = await canceler(setup.repository, executor).cancel({
      currentDirectory: setup.root,
      runId: setup.run.id,
      controllerId: "uncertain-canceler",
    });

    expect(completed.status).toBe("canceled");
    const uncertain = activeVisit(completed).tasks.find(
      (task) => task.id === "active_one",
    )?.attempts[0];
    expect(uncertain).toMatchObject({
      status: "canceled",
      externalStatus: "unknown",
    });
    expect(uncertain?.reconciliation?.confirmedStoppedAt).toBeUndefined();
    expect(
      completed.events.some(
        (event) =>
          event.type === "attempt_cancellation_uncertain" &&
          event.data.identity === uncertain?.id,
      ),
    ).toBe(true);
  });

  it.each<[RunStatus, number]>([
    ["succeeded", 0],
    ["failed", 1],
    ["canceled", 2],
  ])(
    "reports an already-%s run with exit code %i without changing durable state",
    async (status, exitCode) => {
      const setup = await setupActiveRun();
      setup.run.status = status;
      setup.run.controllerLease = undefined;
      setup.run.controllerStatus = "detached";
      if (status === "succeeded") setup.run.terminalTarget = "$succeeded";
      if (status === "failed")
        setup.run.failure = { code: "existing_failure", message: "unchanged" };
      if (status === "canceled")
        setup.run.cancellation = {
          requestedAt: "2026-08-11T12:00:03.000Z",
          completedAt: "2026-08-11T12:00:04.000Z",
        };
      await setup.repository.save(setup.run);
      const before = await readFile(
        path.join(
          setup.root,
          ".happy-machine",
          "runs",
          setup.run.id,
          "run.json",
        ),
        "utf8",
      );
      const executor = new FakeOrcaExecutor();
      const now = clock();
      const stdout: string[] = [];
      const stderr: string[] = [];
      const app = new Cli(
        new ExecuteWorkflow(
          new FilesystemProjectDefinitions(),
          setup.repository,
          executor,
          now,
          () => "unused",
          () => Promise.resolve(),
        ),
        new RecoverWorkflow(setup.repository, executor, now, () =>
          Promise.resolve(),
        ),
        canceler(setup.repository, executor, now),
        new InspectRuns(setup.repository, now),
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
      );

      expect(await app.run(["cancel", setup.run.id], setup.root)).toBe(
        exitCode,
      );
      expect(stdout).toEqual([`Run ${setup.run.id}: ${status}`]);
      expect(stderr).toEqual([]);
      expect(
        await readFile(
          path.join(
            setup.root,
            ".happy-machine",
            "runs",
            setup.run.id,
            "run.json",
          ),
          "utf8",
        ),
      ).toBe(before);
      expect(executor.cancellations).toHaveLength(0);
    },
  );

  it("combines cancel, status, history, and resume rejection without fabricating an outcome", async () => {
    const setup = await setupActiveRun();
    const executor = new FakeOrcaExecutor();
    const now = clock();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const app = new Cli(
      new ExecuteWorkflow(
        new FilesystemProjectDefinitions(),
        setup.repository,
        executor,
        now,
        () => "unused",
        () => Promise.resolve(),
      ),
      new RecoverWorkflow(setup.repository, executor, now, () =>
        Promise.resolve(),
      ),
      canceler(setup.repository, executor, now),
      new InspectRuns(setup.repository, now),
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(await app.run(["cancel", setup.run.id], setup.root)).toBe(2);
    expect(await app.run(["status", setup.run.id], setup.root)).toBe(0);
    expect(stdout.at(-1)).toContain("Status: canceled");
    expect(stdout.at(-1)).toContain("external=stopped");
    expect(await app.run(["history", setup.run.id], setup.root)).toBe(0);
    const history = stdout.at(-1) ?? "";
    expect(history).toContain("run_cancellation_requested");
    expect(history).toContain("attempt_cancellation_requested");
    expect(history).toContain("run_cancellation_completed");
    expect(history).not.toContain("transition_committed");
    const beforeResume = JSON.stringify(
      (await setup.repository.load(setup.root, setup.run.id)).run,
    );
    expect(await app.run(["resume", setup.run.id], setup.root)).toBe(1);
    expect(stderr.at(-1)).toContain("already canceled");
    expect(
      JSON.stringify(
        (await setup.repository.load(setup.root, setup.run.id)).run,
      ),
    ).toBe(beforeResume);
  });

  it("maps attached execute and resume observations of canceled to exit code 2", async () => {
    const setup = await setupActiveRun();
    setup.run.status = "canceled";
    setup.run.cancellation = {
      requestedAt: "2026-08-11T12:00:03.000Z",
      completedAt: "2026-08-11T12:00:04.000Z",
    };
    const executor = new FakeOrcaExecutor();
    const stdout: string[] = [];
    const observed = Promise.resolve(setup.run);
    const app = new Cli(
      { execute: () => observed } as unknown as ExecuteWorkflow,
      { recover: () => observed } as unknown as RecoverWorkflow,
      canceler(setup.repository, executor),
      new InspectRuns(setup.repository, clock()),
      { stdout: (line) => stdout.push(line), stderr: () => undefined },
    );

    expect(await app.run(["execute", "workflow.yaml"], setup.root)).toBe(2);
    expect(await app.run(["resume", setup.run.id], setup.root)).toBe(2);
    expect(stdout).toEqual([
      `Run ${setup.run.id}: canceled`,
      `Run ${setup.run.id}: canceled`,
    ]);
  });
});
