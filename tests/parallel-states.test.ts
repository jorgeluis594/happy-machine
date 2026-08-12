import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExecuteWorkflow,
  type Wait,
} from "../src/application/use-cases/execute-workflow.js";
import type {
  ExecutorReferences,
  RunRecord,
} from "../src/domain/execution/run.js";
import { FilesystemRunRepository } from "../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";
import { FilesystemProjectDefinitions } from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";
import type {
  EffectiveExecutionDefinition,
  EffectivePolicies,
  ExecutionDefinition,
  ParallelTaskDefinition,
  ProjectDefinitions,
  StateDefinition,
} from "../src/ports/project-definitions.js";
import type { RunRepository } from "../src/ports/run-repository.js";
import type {
  TaskExecution,
  TaskExecutor,
  TaskLaunch,
} from "../src/ports/task-executor.js";

interface Gate {
  promise: Promise<void>;
  release(): void;
}

function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 2_000; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

function policies(
  overrides: Partial<EffectivePolicies> = {},
): EffectivePolicies {
  return {
    attemptTimeoutMs: 1_000,
    maxAttempts: 1,
    retryDelayMs: 0,
    workflowTimeoutMs: 86_400_000,
    maxStateVisits: 10,
    maxTransitions: 100,
    maxConcurrency: 4,
    controllerLeaseMs: 30_000,
    ...overrides,
  };
}

function task(
  id: string,
  overrides: Partial<EffectivePolicies> = {},
): ParallelTaskDefinition {
  return {
    id,
    agent: {
      id: `${id}-agent`,
      instructions: `Instructions for ${id}`,
      model: `${id}-model`,
    },
    prompt: id,
    policies: policies(overrides),
  };
}

async function definitions(options: {
  taskDefinitions: ParallelTaskDefinition[];
  maxConcurrency: number;
  failedTarget?: string;
  downstream?: boolean;
}): Promise<{ root: string; definitions: ProjectDefinitions }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-parallel-"));
  await mkdir(path.join(root, "workflows"));
  const workflowPath = path.join(root, "workflows", "parallel.yaml");
  await writeFile(workflowPath, "parallel workflow\n");
  const parallelPolicies = policies({
    maxConcurrency: options.maxConcurrency,
  });
  const tasks = Object.fromEntries(
    options.taskDefinitions.map((definition) => [definition.id, definition]),
  );
  const states: Record<string, StateDefinition> = {
    fan_out: {
      id: "fan_out",
      type: "parallel",
      tasks,
      outcomes: {
        succeeded: options.downstream ? "inspect" : "$succeeded",
        failed:
          options.failedTarget ?? (options.downstream ? "inspect" : "$failed"),
      },
      policies: parallelPolicies,
      effectiveMaxConcurrency: Math.min(
        options.maxConcurrency,
        options.taskDefinitions.length,
      ),
    },
  };
  if (options.downstream) {
    states.inspect = {
      id: "inspect",
      type: "agent",
      agent: {
        id: "inspector",
        instructions: "Inspect the complete join",
        model: "inspector-model",
      },
      prompt: "inspect",
      policies: policies(),
      attemptTimeoutMs: 1_000,
      outcomes: { completed: "$succeeded" },
    };
  }
  const effective: EffectiveExecutionDefinition = {
    workflowId: "parallel-workflow",
    executorType: "orca",
    workspaceMode: "direct",
    agents: {},
    policies: policies(),
    states,
    initialState: "fan_out",
  };
  const loaded: ExecutionDefinition = {
    ...effective,
    projectRoot: root,
    workflowPath,
    snapshotSource: {
      effectiveDefinition: effective,
      artifacts: [
        {
          kind: "workflow",
          logicalId: "workflow",
          content: "parallel workflow\n",
        },
      ],
      inputs: [],
    },
    state: states.fan_out,
  };
  return {
    root,
    definitions: { load: () => Promise.resolve(loaded) },
  };
}

type ExecuteBehavior = (
  launch: TaskLaunch,
  launchNumber: number,
) => Promise<void>;

class InstrumentedExecutor implements TaskExecutor {
  readonly launches: TaskLaunch[] = [];
  readonly cancellations: ExecutorReferences[] = [];
  active = 0;
  maxActive = 0;

  constructor(private readonly behavior: ExecuteBehavior) {}

  async execute(
    launch: TaskLaunch,
    onStarted: (references: ExecutorReferences) => Promise<void>,
  ): Promise<TaskExecution> {
    const launchNumber = this.launches.length + 1;
    this.launches.push(structuredClone(launch));
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const references = {
      runId: `orca-run-${launchNumber}`,
      taskId: `orca-task-${launchNumber}`,
      dispatchId: `dispatch-${launchNumber}`,
      terminalHandle: `terminal-${launchNumber}`,
    };
    await onStarted(references);
    await this.behavior(launch, launchNumber);
    this.active -= 1;
    return {
      references,
      logs: { stdout: "the prose says failed", stderr: "" },
    };
  }

  cancel(references: ExecutorReferences): Promise<void> {
    this.cancellations.push(references);
    if (this.active > 0) this.active -= 1;
    return Promise.resolve();
  }

  reconcile(): Promise<"stopped"> {
    return Promise.resolve("stopped");
  }
}

async function writeResult(
  launch: TaskLaunch,
  outcome: "succeeded" | "failed" | "completed",
  documents: Array<{ path: string; content: string }> = [],
  error?: unknown,
): Promise<void> {
  for (const document of documents)
    await writeFile(
      path.join(launch.outputDirectory, document.path),
      document.content,
    );
  await writeFile(
    launch.resultPath,
    `${JSON.stringify({
      outcome,
      documents: documents.map((document) => document.path),
      ...(error === undefined ? {} : { error }),
    })}\n`,
  );
}

const normalWait: Wait = (_milliseconds, signal) =>
  signal ? new Promise(() => {}) : Promise.resolve();

async function execute(
  projectDefinitions: ProjectDefinitions,
  executor: TaskExecutor,
  repository: RunRepository = new FilesystemRunRepository(),
  wait: Wait = normalWait,
  request: { workflowPath: string; currentDirectory: string } = {
    workflowPath: "parallel.yaml",
    currentDirectory: "/unused",
  },
): Promise<RunRecord> {
  let id = 0;
  return new ExecuteWorkflow(
    projectDefinitions,
    repository,
    executor,
    () => new Date("2026-08-11T12:00:00.000Z"),
    () => `id-${++id}`,
    wait,
  ).execute({
    ...request,
    onRunAllocated: () => {},
  });
}

async function parsedProject(): Promise<{ root: string; workflow: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-parallel-e2e-"));
  await mkdir(path.join(root, "agents"));
  await mkdir(path.join(root, "workflows"));
  await writeFile(
    path.join(root, "agents", "worker.md"),
    "# Worker\nExecute the assigned check.\n",
  );
  await writeFile(
    path.join(root, "happy-machine.yaml"),
    `version: 1
agents:
  worker:
    instructions: agents/worker.md
    model: parsed-model
defaults:
  attempt_timeout: 5s
  max_attempts: 1
  retry_delay: 1ms
  max_concurrency: 2
`,
  );
  const workflow = path.join(root, "workflows", "parallel.yaml");
  await writeFile(
    workflow,
    `version: 1
id: parsed-parallel
initial_state: checks
states:
  checks:
    type: parallel
    max_concurrency: 2
    tasks:
      alpha:
        agent: worker
        prompt: alpha
      beta:
        agent: worker
        prompt: beta
    outcomes:
      succeeded: $succeeded
      failed: $failed
`,
  );
  return { root, workflow };
}

describe("parallel states", () => {
  it.each([
    [
      "successful",
      new Map([
        ["alpha", "succeeded"],
        ["beta", "succeeded"],
      ]),
      "succeeded",
    ],
    [
      "failed",
      new Map([
        ["alpha", "failed"],
        ["beta", "succeeded"],
      ]),
      "failed",
    ],
  ] as const)(
    "executes a parsed %s parallel workflow end to end",
    async (_label, outcomes, expected) => {
      const setup = await parsedProject();
      const executor = new InstrumentedExecutor((launch) =>
        writeResult(
          launch,
          outcomes.get(launch.prompt)! as "succeeded" | "failed",
        ),
      );
      const run = await execute(
        new FilesystemProjectDefinitions(),
        executor,
        new FilesystemRunRepository(),
        normalWait,
        { workflowPath: setup.workflow, currentDirectory: setup.root },
      );

      expect(run.status).toBe(expected);
      expect(executor.launches).toHaveLength(2);
      expect(executor.launches.map((launch) => launch.model)).toEqual([
        "parsed-model",
        "parsed-model",
      ]);
      expect(executor.launches.map((launch) => launch.allowedOutcomes)).toEqual(
        [
          ["succeeded", "failed"],
          ["succeeded", "failed"],
        ],
      );
      expect(run.visits[0]).toMatchObject({
        type: "parallel",
        outcome: expected,
        target: expected === "succeeded" ? "$succeeded" : "$failed",
      });
    },
  );

  it("waits for all successful tasks and enforces bounded concurrency", async () => {
    const setup = await definitions({
      taskDefinitions: [task("one"), task("two"), task("three")],
      maxConcurrency: 2,
    });
    const gates = [gate(), gate(), gate()];
    const executor = new InstrumentedExecutor(async (launch, launchNumber) => {
      await gates[launchNumber - 1].promise;
      await writeResult(launch, "succeeded");
    });
    let settled = false;
    const execution = execute(setup.definitions, executor).finally(() => {
      settled = true;
    });

    await eventually(() => executor.launches.length === 2);
    expect(executor.maxActive).toBe(2);
    expect(settled).toBe(false);
    gates[0].release();
    await eventually(() => executor.launches.length === 3);
    expect(executor.maxActive).toBe(2);
    expect(settled).toBe(false);
    gates[1].release();
    await eventually(() => executor.active === 1);
    expect(settled).toBe(false);
    gates[2].release();

    const run = await execution;
    expect(run.status).toBe("succeeded");
    expect(run.visits[0]).toMatchObject({
      type: "parallel",
      outcome: "succeeded",
      target: "$succeeded",
    });
    expect(
      run.events.filter((event) => event.type === "transition_committed"),
    ).toHaveLength(1);
  });

  it("does not fail fast and starts every queued task before emitting failed", async () => {
    const setup = await definitions({
      taskDefinitions: [
        task("one"),
        task("two"),
        task("three"),
        task("four"),
        task("five"),
      ],
      maxConcurrency: 2,
    });
    const gates = Array.from({ length: 5 }, gate);
    const executor = new InstrumentedExecutor(async (launch, launchNumber) => {
      await gates[launchNumber - 1].promise;
      await writeResult(
        launch,
        launch.prompt === "one" ? "failed" : "succeeded",
        [],
        launch.prompt === "one" ? { reason: "review failed" } : undefined,
      );
    });
    let settled = false;
    const execution = execute(setup.definitions, executor).finally(() => {
      settled = true;
    });

    for (let index = 0; index < gates.length; index += 1) {
      await eventually(
        () => executor.launches.length === Math.min(index + 2, gates.length),
      );
      if (index < gates.length - 1) expect(settled).toBe(false);
      gates[index].release();
    }
    const run = await execution;
    expect(executor.maxActive).toBe(2);
    expect(executor.launches).toHaveLength(5);
    expect(run.status).toBe("failed");
    const visit = run.visits[0];
    if (visit.type !== "parallel") throw new Error("expected parallel visit");
    expect(visit.outcome).toBe("failed");
    expect(visit.tasks.find((item) => item.id === "one")?.status).toBe(
      "failed",
    );
    expect(
      visit.tasks
        .filter((item) => item.id !== "one")
        .every((item) => item.status === "succeeded"),
    ).toBe(true);
  });

  it("uses the task count as the effective limit when max_concurrency is larger", async () => {
    const setup = await definitions({
      taskDefinitions: [task("one"), task("two")],
      maxConcurrency: 20,
    });
    const gates = [gate(), gate()];
    const executor = new InstrumentedExecutor(async (launch, launchNumber) => {
      await gates[launchNumber - 1].promise;
      await writeResult(launch, "succeeded");
    });
    const execution = execute(setup.definitions, executor);
    await eventually(() => executor.launches.length === 2);
    expect(executor.maxActive).toBe(2);
    gates.forEach((item) => item.release());
    await expect(execution).resolves.toMatchObject({ status: "succeeded" });
  });

  it("freezes sibling context, isolates control outputs, and exposes the complete join downstream", async () => {
    const setup = await definitions({
      taskDefinitions: [task("fast"), task("queued"), task("failed")],
      maxConcurrency: 1,
      downstream: true,
    });
    let queuedContext = "";
    let inspectorContext = "";
    const executor = new InstrumentedExecutor(async (launch) => {
      if (launch.prompt === "fast") {
        await writeResult(launch, "succeeded", [
          { path: "report.md", content: "fast result\n" },
        ]);
      } else if (launch.prompt === "queued") {
        queuedContext = await readFile(launch.contextPath, "utf8");
        await writeResult(launch, "succeeded", [
          { path: "report.md", content: "queued result\n" },
        ]);
      } else if (launch.prompt === "failed") {
        await writeResult(launch, "failed", [], { reason: "broken" });
      } else {
        inspectorContext = await readFile(launch.contextPath, "utf8");
        await writeResult(launch, "completed");
      }
    });
    const run = await execute(setup.definitions, executor);

    expect(run.status).toBe("succeeded");
    expect(queuedContext).not.toContain("fast result");
    expect(queuedContext).not.toContain("report.md");
    expect(inspectorContext).not.toContain("fast result");
    expect(inspectorContext).toContain("Task fast");
    expect(inspectorContext).toContain("Task queued");
    expect(inspectorContext).toContain("Task failed");
    expect(inspectorContext).toContain("Status: failed");
    expect(inspectorContext).toContain("Attempts: 1");
    expect(inspectorContext).toContain("declared_failed");
    expect(inspectorContext.match(/### report\.md/g)).toHaveLength(2);
    const parallel = run.visits[0];
    if (parallel.type !== "parallel") throw new Error("expected parallel");
    expect(new Set(parallel.tasks.map((item) => item.workspace.path))).toEqual(
      new Set([setup.root]),
    );
    expect(
      new Set(parallel.tasks.map((item) => item.attempts[0].controlWorkspace))
        .size,
    ).toBe(3);
    expect(
      new Set(parallel.tasks.map((item) => item.attempts[0].outputDirectory))
        .size,
    ).toBe(3);
    expect(
      new Set(parallel.tasks.map((item) => item.attempts[0].resultPath)).size,
    ).toBe(3);
    expect(
      new Set(
        parallel.tasks.map((item) => item.attempts[0].executor?.dispatchId),
      ).size,
    ).toBe(3);
    expect(
      parallel.tasks.every(
        (item) => item.attempts[0].logs.stdout === "the prose says failed",
      ),
    ).toBe(true);
    expect(run.documents.map((document) => document.taskId)).toEqual([
      "fast",
      "queued",
    ]);
    expect(run.documents.map((document) => document.name)).toEqual([
      "report.md",
      "report.md",
    ]);
  });

  it("retries a declared failure independently without repeating its sibling", async () => {
    const setup = await definitions({
      taskDefinitions: [task("flaky", { maxAttempts: 2 }), task("steady")],
      maxConcurrency: 2,
    });
    const attempts = new Map<string, number>();
    const executor = new InstrumentedExecutor(async (launch) => {
      const count = (attempts.get(launch.prompt) ?? 0) + 1;
      attempts.set(launch.prompt, count);
      await writeResult(
        launch,
        launch.prompt === "flaky" && count === 1 ? "failed" : "succeeded",
        [],
        launch.prompt === "flaky" && count === 1
          ? { reason: "temporary" }
          : undefined,
      );
    });
    const run = await execute(setup.definitions, executor);
    const visit = run.visits[0];
    if (visit.type !== "parallel") throw new Error("expected parallel");

    expect(run.status).toBe("succeeded");
    expect(attempts).toEqual(
      new Map([
        ["flaky", 2],
        ["steady", 1],
      ]),
    );
    expect(visit.tasks[0].attempts).toHaveLength(2);
    expect(visit.tasks[0].attempts[0]).toMatchObject({
      status: "failed",
      failure: { code: "declared_failed" },
    });
    expect(visit.tasks[0].status).toBe("succeeded");
    expect(visit.tasks[1].attempts).toHaveLength(1);
  });

  it("applies timeouts and retry budgets independently per task", async () => {
    const setup = await definitions({
      taskDefinitions: [
        task("timeout", { attemptTimeoutMs: 1, maxAttempts: 1 }),
        task("steady", { attemptTimeoutMs: 1_000, maxAttempts: 1 }),
      ],
      maxConcurrency: 2,
    });
    const executor = new InstrumentedExecutor(async (launch) => {
      if (launch.prompt === "timeout") return new Promise(() => {});
      await writeResult(launch, "succeeded");
    });
    const timeoutWait: Wait = (milliseconds, signal) => {
      if (!signal) return Promise.resolve();
      return milliseconds === 1 ? Promise.resolve() : new Promise(() => {});
    };
    const run = await execute(
      setup.definitions,
      executor,
      new FilesystemRunRepository(),
      timeoutWait,
    );
    const visit = run.visits[0];
    if (visit.type !== "parallel") throw new Error("expected parallel");

    expect(visit.outcome).toBe("failed");
    const timedOut = visit.tasks.find((item) => item.id === "timeout")!;
    const steady = visit.tasks.find((item) => item.id === "steady")!;
    expect(timedOut).toMatchObject({
      status: "failed",
      failure: { code: "attempt_timeout" },
    });
    expect(steady).toMatchObject({
      status: "succeeded",
      attempts: [{ status: "succeeded" }],
    });
    expect(executor.cancellations).toHaveLength(1);
  });

  it("treats aggregate persistence failure as an engine failure and skips the configured transition", async () => {
    const setup = await definitions({
      taskDefinitions: [task("one"), task("two")],
      maxConcurrency: 2,
      downstream: true,
    });
    const filesystem = new FilesystemRunRepository();
    let injected = false;
    const repository: RunRepository = {
      createSnapshot: (request) => filesystem.createSnapshot(request),
      prepareVisitContext: (run) => filesystem.prepareVisitContext(run),
      prepareAttempt: (run, visit, selectedTask, attemptNumber) =>
        filesystem.prepareAttempt(run, visit, selectedTask, attemptNumber),
      readResult: (resultPath, outputDirectory, outcomes) =>
        filesystem.readResult(resultPath, outputDirectory, outcomes),
      stageDocuments: (run, visit, selectedTask, outputDirectory, names) =>
        filesystem.stageDocuments(
          run,
          visit,
          selectedTask,
          outputDirectory,
          names,
        ),
      save: async (run) => {
        const visit = run.visits[0];
        if (
          !injected &&
          visit?.type === "parallel" &&
          visit.target === "inspect"
        ) {
          injected = true;
          throw new Error("injected aggregate persistence failure");
        }
        await filesystem.save(run);
      },
    };
    const executor = new InstrumentedExecutor((launch) =>
      writeResult(
        launch,
        launch.prompt === "inspect" ? "completed" : "succeeded",
      ),
    );

    await expect(
      execute(setup.definitions, executor, repository),
    ).rejects.toThrow("injected aggregate persistence failure");
    expect(executor.launches.map((launch) => launch.prompt)).toEqual([
      "one",
      "two",
    ]);
    const runJson = await readFile(
      path.join(setup.root, ".happy-machine", "runs", "run_id-1", "run.json"),
      "utf8",
    );
    const stored = JSON.parse(runJson) as RunRecord;
    expect(stored.status).toBe("failed");
    expect(stored.failure).toMatchObject({
      code: "engine_failure",
      message: "injected aggregate persistence failure",
    });
    expect(stored.visits).toHaveLength(1);
    expect(stored.visits[0].target).toBeUndefined();
  });
});
