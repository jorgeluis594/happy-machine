import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RecoverWorkflow } from "../src/application/use-cases/recover-workflow.js";
import type {
  AttemptRecord,
  ExecutorReferences,
  ParallelVisitRecord,
  RunRecord,
  VisitRecord,
} from "../src/domain/execution/run.js";
import { FilesystemRunRepository } from "../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";
import type {
  EffectiveExecutionDefinition,
  EffectivePolicies,
  StateDefinition,
} from "../src/ports/project-definitions.js";
import {
  ControllerLeaseLostError,
  type RunRepository,
  RunAlreadyControlledError,
} from "../src/ports/run-repository.js";
import type {
  RecoveryObservation,
  TaskExecution,
  TaskExecutor,
  TaskLaunch,
} from "../src/ports/task-executor.js";

function policies(
  overrides: Partial<EffectivePolicies> = {},
): EffectivePolicies {
  return {
    attemptTimeoutMs: 500,
    maxAttempts: 2,
    retryDelayMs: 0,
    workflowTimeoutMs: 60_000,
    maxStateVisits: 10,
    maxTransitions: 100,
    maxConcurrency: 2,
    controllerLeaseMs: 100,
    ...overrides,
  };
}

function normalState(): StateDefinition {
  const effective = policies();
  return {
    id: "work",
    type: "agent",
    agent: {
      id: "worker",
      instructions: "Recover the work",
      model: "recovery-model",
    },
    prompt: "work",
    policies: effective,
    attemptTimeoutMs: effective.attemptTimeoutMs,
    outcomes: { done: "$succeeded" },
  };
}

function parallelState(): StateDefinition {
  const effective = policies();
  const task = (id: string) => ({
    id,
    agent: {
      id: `${id}-agent`,
      instructions: `Recover ${id}`,
      model: "recovery-model",
    },
    prompt: id,
    policies: effective,
  });
  return {
    id: "fan_out",
    type: "parallel",
    tasks: {
      settled: task("settled"),
      existing: task("existing"),
      queued: task("queued"),
    },
    outcomes: { succeeded: "$succeeded", failed: "$failed" },
    policies: effective,
    effectiveMaxConcurrency: 2,
  };
}

async function durableSetup(state: StateDefinition): Promise<{
  root: string;
  repository: FilesystemRunRepository;
  definition: EffectiveExecutionDefinition;
  run: RunRecord;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-recovery-"));
  const repository = new FilesystemRunRepository();
  const definition: EffectiveExecutionDefinition = {
    workflowId: "recovery-workflow",
    executorType: "orca",
    workspaceMode: "direct",
    agents: {},
    policies: policies(),
    states: { [state.id]: state },
    initialState: state.id,
  };
  const snapshot = await repository.createSnapshot({
    runId: "run-recovery",
    projectRoot: root,
    workflowId: definition.workflowId,
    source: {
      effectiveDefinition: definition,
      artifacts: [
        {
          kind: "workflow",
          logicalId: "workflow",
          content: "recovery workflow\n",
        },
      ],
      inputs: [],
    },
  });
  const run: RunRecord = {
    id: "run-recovery",
    workflowId: definition.workflowId,
    workflowPath: path.join(root, "workflow.yaml"),
    projectRoot: root,
    definitionSnapshot: snapshot.record,
    status: "running",
    createdAt: "2026-08-11T00:00:00.000Z",
    deadlineAt: "2026-08-12T00:00:00.000Z",
    transitionCount: 0,
    visits: [],
    documents: [],
    events: [],
  };
  await repository.save(run);
  return { root, repository, definition, run };
}

async function addVisit(
  setup: Awaited<ReturnType<typeof durableSetup>>,
): Promise<VisitRecord> {
  const state = setup.definition.states[setup.definition.initialState];
  const visit: VisitRecord =
    state.type === "agent"
      ? {
          type: "agent",
          stateId: state.id,
          number: 1,
          contextPath: "",
          task: { id: `${state.id}-task`, attempts: [] },
        }
      : {
          type: "parallel",
          stateId: state.id,
          number: 1,
          contextPath: "",
          tasks: Object.values(state.tasks).map((task) => ({
            id: task.id,
            status: "queued",
            attempts: [],
            documents: [],
            workspace: { mode: "direct", path: setup.root },
          })),
        };
  setup.run.visits.push(visit);
  visit.contextPath = await setup.repository.prepareVisitContext(setup.run);
  await setup.repository.save(setup.run);
  return visit;
}

async function addAttempt(
  setup: Awaited<ReturnType<typeof durableSetup>>,
  visit: VisitRecord,
  task: { id: string; attempts: AttemptRecord[] },
  number = 1,
): Promise<AttemptRecord> {
  const attempt: AttemptRecord = {
    id: `${setup.run.id}:${visit.stateId}:${visit.number}:${task.id}:${number}`,
    number,
    status: "launching",
    controlWorkspace: "",
    contextPath: "",
    outputDirectory: "",
    resultPath: "",
    logs: { stdout: "", stderr: "" },
    documents: [],
  };
  task.attempts.push(attempt);
  Object.assign(
    attempt,
    await setup.repository.prepareAttempt(setup.run, visit, task, number),
  );
  await setup.repository.save(setup.run);
  return attempt;
}

async function writeResult(
  attempt: Pick<AttemptRecord, "resultPath" | "outputDirectory">,
  outcome = "done",
  documents: Array<{ path: string; content: string }> = [],
): Promise<void> {
  await mkdir(attempt.outputDirectory, { recursive: true });
  for (const document of documents)
    await writeFile(
      path.join(attempt.outputDirectory, document.path),
      document.content,
    );
  await writeFile(
    attempt.resultPath,
    `${JSON.stringify({
      outcome,
      documents: documents.map((document) => document.path),
    })}\n`,
  );
}

const references = (identity: string): ExecutorReferences => ({
  runId: `orca:${identity}`,
  taskId: `task:${identity}`,
  dispatchId: `dispatch:${identity}`,
  terminalHandle: `terminal:${identity}`,
});

class RecoveryExecutor implements TaskExecutor {
  readonly launches: TaskLaunch[] = [];
  readonly recoveries: string[] = [];

  constructor(
    private readonly observe: (
      identity: string,
      known: ExecutorReferences | undefined,
    ) => Promise<RecoveryObservation>,
  ) {}

  recover(
    identity: string,
    known: ExecutorReferences | undefined,
  ): Promise<RecoveryObservation> {
    this.recoveries.push(identity);
    return this.observe(identity, known);
  }

  async execute(
    launch: TaskLaunch,
    onStarted: (external: ExecutorReferences) => Promise<void>,
  ): Promise<TaskExecution> {
    this.launches.push(structuredClone(launch));
    const external = references(launch.identity);
    await onStarted(external);
    await writeResult(
      {
        resultPath: launch.resultPath,
        outputDirectory: launch.outputDirectory,
      },
      launch.prompt === "work" ? "done" : "succeeded",
    );
    return { references: external, logs: { stdout: "launched", stderr: "" } };
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  reconcile(): Promise<"stopped"> {
    return Promise.resolve("stopped");
  }
}

function recoverer(
  repository: RunRepository,
  executor: TaskExecutor,
  now = () => new Date("2026-08-11T00:00:00.000Z"),
) {
  return new RecoverWorkflow(repository, executor, now, () =>
    Promise.resolve(),
  );
}

describe("durable controller leases", () => {
  it("rejects a competing controller without mutating the durable run", async () => {
    const setup = await durableSetup(normalState());
    const first = await setup.repository.acquireControl(
      setup.root,
      setup.run.id,
      "controller-one",
      "2026-08-11T00:00:00.000Z",
    );
    const before = JSON.stringify(
      (await setup.repository.load(setup.root, setup.run.id)).run,
    );

    await expect(
      setup.repository.acquireControl(
        setup.root,
        setup.run.id,
        "controller-two",
        "2026-08-11T00:00:00.050Z",
      ),
    ).rejects.toBeInstanceOf(RunAlreadyControlledError);
    expect(
      JSON.stringify(
        (await setup.repository.load(setup.root, setup.run.id)).run,
      ),
    ).toBe(before);
    expect(first.fencingToken).toBe(1);
  });

  it("permits expired takeover, renews, and fences the stale controller", async () => {
    const setup = await durableSetup(normalState());
    const first = await setup.repository.acquireControl(
      setup.root,
      setup.run.id,
      "controller-one",
      "2026-08-11T00:00:00.000Z",
    );
    const renewed = await setup.repository.renewControl(
      first.run,
      "controller-one",
      first.fencingToken,
      "2026-08-11T00:00:00.050Z",
    );
    expect(renewed.run.controllerLease?.expiresAt).toBe(
      "2026-08-11T00:00:00.150Z",
    );
    const renewedAgain = await setup.repository.renewControl(
      renewed.run,
      "controller-one",
      renewed.fencingToken,
      "2026-08-11T00:00:00.120Z",
    );
    expect(renewedAgain.run.controllerLease?.expiresAt).toBe(
      "2026-08-11T00:00:00.220Z",
    );
    const second = await setup.repository.acquireControl(
      setup.root,
      setup.run.id,
      "controller-two",
      "2026-08-11T00:00:00.221Z",
    );
    expect(second.fencingToken).toBe(2);
    await expect(
      setup.repository.saveControlled(
        first.run,
        "controller-one",
        first.fencingToken,
      ),
    ).rejects.toBeInstanceOf(ControllerLeaseLostError);
  });
});

describe("durable recovery", () => {
  it("launches exactly once after a crash before external launch", async () => {
    const setup = await durableSetup(normalState());
    const visit = await addVisit(setup);
    if (visit.type !== "agent") throw new Error("expected agent visit");
    await addAttempt(setup, visit, visit.task);
    const executor = new RecoveryExecutor(() =>
      Promise.resolve({ status: "not_found" }),
    );

    const run = await recoverer(setup.repository, executor).recover({
      projectRoot: setup.root,
      runId: setup.run.id,
      controllerId: "recovery-one",
    });

    expect(run.status).toBe("succeeded");
    expect(executor.launches).toHaveLength(1);
    expect(executor.recoveries).toHaveLength(1);
  });

  it("finds a completed launch in the ID window and never launches again", async () => {
    const setup = await durableSetup(normalState());
    const visit = await addVisit(setup);
    if (visit.type !== "agent") throw new Error("expected agent visit");
    const attempt = await addAttempt(setup, visit, visit.task);
    await writeResult(attempt);
    const executor = new RecoveryExecutor((identity) =>
      Promise.resolve({
        status: "completed",
        references: references(identity),
        logs: { stdout: "recovered", stderr: "" },
      }),
    );

    const run = await recoverer(setup.repository, executor).recover({
      projectRoot: setup.root,
      runId: setup.run.id,
      controllerId: "recovery-one",
    });
    expect(run.status).toBe("succeeded");
    expect(executor.launches).toHaveLength(0);
    const recoveredVisit = run.visits[0];
    if (recoveredVisit.type !== "agent") throw new Error("expected agent");
    expect(recoveredVisit.task.attempts[0].executor).toEqual(
      references(attempt.id),
    );
  });

  it("commits recovered documents and remains idempotent on repeated recovery", async () => {
    const setup = await durableSetup(normalState());
    const visit = await addVisit(setup);
    if (visit.type !== "agent") throw new Error("expected agent visit");
    const attempt = await addAttempt(setup, visit, visit.task);
    await writeResult(attempt, "done", [
      { path: "report.md", content: "recovered report\n" },
    ]);
    const executor = new RecoveryExecutor((identity) =>
      Promise.resolve({
        status: "completed",
        references: references(identity),
        logs: { stdout: "recovered", stderr: "" },
      }),
    );
    const useCase = recoverer(setup.repository, executor);
    const first = await useCase.recover({
      projectRoot: setup.root,
      runId: setup.run.id,
      controllerId: "recovery-one",
    });
    const firstEvents = first.events.length;
    const second = await useCase.recover({
      projectRoot: setup.root,
      runId: setup.run.id,
      controllerId: "recovery-two",
    });

    expect(second.documents).toHaveLength(1);
    expect(second.transitionCount).toBe(1);
    expect(second.events).toHaveLength(firstEvents);
    expect(executor.launches).toHaveLength(0);
  });

  it("leaves the last committed state recoverable when transition persistence fails", async () => {
    const setup = await durableSetup(normalState());
    const visit = await addVisit(setup);
    if (visit.type !== "agent") throw new Error("expected agent visit");
    const attempt = await addAttempt(setup, visit, visit.task);
    await writeResult(attempt);
    const executor = new RecoveryExecutor((identity) =>
      Promise.resolve({
        status: "completed",
        references: references(identity),
        logs: { stdout: "complete", stderr: "" },
      }),
    );
    let injected = false;
    const repository: RunRepository = {
      createSnapshot: (request) => setup.repository.createSnapshot(request),
      load: (projectRoot, runId) => setup.repository.load(projectRoot, runId),
      acquireControl: (projectRoot, runId, controllerId, observedAt) =>
        setup.repository.acquireControl(
          projectRoot,
          runId,
          controllerId,
          observedAt,
        ),
      renewControl: (run, controllerId, fencingToken, observedAt) =>
        setup.repository.renewControl(
          run,
          controllerId,
          fencingToken,
          observedAt,
        ),
      saveControlled: async (run, controllerId, fencingToken) => {
        if (!injected && run.transitionCount === 1) {
          injected = true;
          throw new Error("injected transition commit failure");
        }
        await setup.repository.saveControlled(run, controllerId, fencingToken);
      },
      releaseControl: (run, controllerId, fencingToken, observedAt) =>
        setup.repository.releaseControl(
          run,
          controllerId,
          fencingToken,
          observedAt,
        ),
      save: (run) => setup.repository.save(run),
      prepareVisitContext: (run) => setup.repository.prepareVisitContext(run),
      prepareAttempt: (run, selectedVisit, task, number) =>
        setup.repository.prepareAttempt(run, selectedVisit, task, number),
      readResult: (resultPath, outputDirectory, outcomes) =>
        setup.repository.readResult(resultPath, outputDirectory, outcomes),
      stageDocuments: (run, selectedVisit, task, outputDirectory, names) =>
        setup.repository.stageDocuments(
          run,
          selectedVisit,
          task,
          outputDirectory,
          names,
        ),
    };

    await expect(
      recoverer(repository, executor).recover({
        projectRoot: setup.root,
        runId: setup.run.id,
        controllerId: "recovery-one",
      }),
    ).rejects.toThrow("injected transition commit failure");
    const stored = (await setup.repository.load(setup.root, setup.run.id)).run;
    expect(stored.status).toBe("running");
    expect(stored.transitionCount).toBe(0);
    expect(stored.visits[0]).not.toHaveProperty("outcome");
    expect(executor.launches).toHaveLength(0);
  });

  it("takes over an expired lease but observes active Orca work", async () => {
    const setup = await durableSetup(normalState());
    const visit = await addVisit(setup);
    if (visit.type !== "agent") throw new Error("expected agent visit");
    const attempt = await addAttempt(setup, visit, visit.task);
    attempt.executor = references(attempt.id);
    attempt.status = "running";
    await setup.repository.save(setup.run);
    await setup.repository.acquireControl(
      setup.root,
      setup.run.id,
      "dead-controller",
      "2026-08-11T00:00:00.000Z",
    );
    await writeResult(attempt);
    let observations = 0;
    const executor = new RecoveryExecutor((identity) => {
      observations += 1;
      return Promise.resolve({
        status: observations === 1 ? "active" : "completed",
        references: references(identity),
        logs: { stdout: "existing", stderr: "" },
      });
    });
    const run = await recoverer(
      setup.repository,
      executor,
      () => new Date("2026-08-11T00:00:00.101Z"),
    ).recover({
      projectRoot: setup.root,
      runId: setup.run.id,
      controllerId: "new-controller",
    });

    expect(run.status).toBe("succeeded");
    expect(executor.launches).toHaveLength(0);
    expect(observations).toBe(2);
  });

  it.each(["start_unknown", "stop_unknown"] as const)(
    "fails safely on irreconcilable %s without launching",
    async (status) => {
      const setup = await durableSetup(normalState());
      const visit = await addVisit(setup);
      if (visit.type !== "agent") throw new Error("expected agent visit");
      const attempt = await addAttempt(setup, visit, visit.task);
      const executor = new RecoveryExecutor((identity) =>
        Promise.resolve({
          status,
          references: references(identity),
          logs: { stdout: "unknown", stderr: "" },
        }),
      );
      const run = await recoverer(setup.repository, executor).recover({
        projectRoot: setup.root,
        runId: setup.run.id,
        controllerId: "recovery-one",
      });

      expect(run).toMatchObject({
        status: "failed",
        failure: { code: "external_execution_uncertain" },
      });
      expect(executor.launches).toHaveLength(0);
      expect(attempt.id).toContain("run-recovery");
    },
  );

  it("reconstructs a partially settled parallel visit from storage", async () => {
    const setup = await durableSetup(parallelState());
    const visit = (await addVisit(setup)) as ParallelVisitRecord;
    const settled = visit.tasks.find((task) => task.id === "settled")!;
    settled.status = "succeeded";
    settled.outcome = "succeeded";
    const settledAttempt = await addAttempt(setup, visit, settled);
    settledAttempt.status = "succeeded";
    settledAttempt.outcome = "succeeded";
    const existing = visit.tasks.find((task) => task.id === "existing")!;
    existing.status = "running";
    const existingAttempt = await addAttempt(setup, visit, existing);
    existingAttempt.status = "running";
    existingAttempt.executor = references(existingAttempt.id);
    await writeResult(existingAttempt, "succeeded");
    await setup.repository.save(setup.run);
    const executor = new RecoveryExecutor((identity) =>
      Promise.resolve(
        identity.includes(":existing:")
          ? {
              status: "completed",
              references: references(identity),
              logs: { stdout: "existing", stderr: "" },
            }
          : { status: "not_found" },
      ),
    );

    const run = await recoverer(setup.repository, executor).recover({
      projectRoot: setup.root,
      runId: setup.run.id,
      controllerId: "recovery-one",
    });
    const recovered = run.visits[0] as ParallelVisitRecord;

    expect(run.status).toBe("succeeded");
    expect(recovered.tasks.map((task) => task.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(executor.launches.map((launch) => launch.prompt)).toEqual([
      "queued",
    ]);
  });

  it("loads all durable counters and attempt state without prior memory", async () => {
    const setup = await durableSetup(normalState());
    const visit = await addVisit(setup);
    if (visit.type !== "agent") throw new Error("expected agent visit");
    await addAttempt(setup, visit, visit.task);
    setup.run.transitionCount = 7;
    await setup.repository.save(setup.run);

    const loaded = await new FilesystemRunRepository().load(
      setup.root,
      setup.run.id,
    );
    expect(loaded.run.transitionCount).toBe(7);
    expect(loaded.run.visits[0]).toMatchObject({
      stateId: "work",
      number: 1,
      task: { attempts: [{ status: "launching", number: 1 }] },
    });
    expect(loaded.definition.states.work.type).toBe("agent");
  });
});
