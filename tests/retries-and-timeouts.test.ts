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
  ExternalEventRecord,
  ExternalExecutionStatus,
  NormalVisitRecord,
  RunRecord,
} from "../src/domain/execution/run.js";
import { FilesystemRunRepository } from "../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";
import type {
  EffectiveExecutionDefinition,
  EffectivePolicies,
  ExecutionDefinition,
  ProjectDefinitions,
} from "../src/ports/project-definitions.js";
import type {
  TaskExecution,
  TaskExecutor,
  TaskLaunch,
} from "../src/ports/task-executor.js";
import { TaskExecutorError } from "../src/ports/task-executor.js";

interface Behavior {
  run(
    launch: TaskLaunch,
    onEvent?: (event: ExternalEventRecord) => Promise<void>,
  ): Promise<void>;
}

function normalVisit(run: RunRecord, index = 0): NormalVisitRecord {
  const visit = run.visits[index];
  if (!visit || visit.type !== "agent") throw new Error("expected agent visit");
  return visit;
}

const references = (attempt: number): ExecutorReferences => ({
  runId: `orca-run-${attempt}`,
  taskId: `orca-task-${attempt}`,
  dispatchId: `orca-dispatch-${attempt}`,
  terminalHandle: `terminal-${attempt}`,
});

class ScriptedExecutor implements TaskExecutor {
  readonly launches: TaskLaunch[] = [];
  readonly cancellations: ExecutorReferences[] = [];
  readonly reconciliations: ExternalExecutionStatus[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    private readonly behaviors: Behavior[],
    private readonly statuses: ExternalExecutionStatus[] = ["stopped"],
  ) {}

  async execute(
    launch: TaskLaunch,
    onStarted: (references: ExecutorReferences) => Promise<void>,
    onEvent?: (event: ExternalEventRecord) => Promise<void>,
  ): Promise<TaskExecution> {
    this.launches.push(structuredClone(launch));
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const external = references(launch.attemptNumber);
    await onStarted(external);
    try {
      await this.behaviors[launch.attemptNumber - 1].run(launch, onEvent);
      this.active -= 1;
      return {
        references: external,
        logs: {
          stdout: `stdout attempt ${launch.attemptNumber}`,
          stderr: `stderr attempt ${launch.attemptNumber}`,
        },
      };
    } catch (error) {
      this.active -= 1;
      throw error;
    }
  }

  cancel(external: ExecutorReferences): Promise<void> {
    this.cancellations.push(external);
    return Promise.resolve();
  }

  reconcile(): Promise<ExternalExecutionStatus> {
    const status = this.statuses.shift() ?? "unknown";
    this.reconciliations.push(status);
    if (status === "stopped" && this.active > 0) this.active -= 1;
    return Promise.resolve(status);
  }
}

function policies(
  overrides: Partial<EffectivePolicies> = {},
): EffectivePolicies {
  return {
    attemptTimeoutMs: 1_000,
    maxAttempts: 3,
    retryDelayMs: 50,
    workflowTimeoutMs: 86_400_000,
    maxStateVisits: 10,
    maxTransitions: 100,
    maxConcurrency: 4,
    controllerLeaseMs: 30_000,
    ...overrides,
  };
}

async function definition(
  overrides: Partial<EffectivePolicies> = {},
): Promise<{ root: string; definitions: ProjectDefinitions }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-retries-"));
  await mkdir(path.join(root, "workflows"));
  const workflowPath = path.join(root, "workflows", "retry.yaml");
  await writeFile(workflowPath, "snapshot workflow\n");
  const effectivePolicies = policies(overrides);
  const effective: EffectiveExecutionDefinition = {
    workflowId: "retry-workflow",
    executorType: "orca",
    workspaceMode: "direct",
    agents: {
      worker: {
        id: "worker",
        instructions: "Immutable instructions\n",
        runtime: "codex",
      },
    },
    policies: effectivePolicies,
    initialState: "review",
    states: {
      review: {
        id: "review",
        type: "agent",
        agent: {
          id: "worker",
          instructions: "Immutable instructions\n",
          runtime: "codex",
        },
        prompt: "Immutable prompt",
        policies: effectivePolicies,
        attemptTimeoutMs: effectivePolicies.attemptTimeoutMs,
        outcomes: { approved: "$succeeded" },
      },
    },
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
          content: "snapshot workflow\n",
        },
        {
          kind: "agent_instructions",
          logicalId: "worker",
          content: "Immutable instructions\n",
        },
        {
          kind: "inline_prompt",
          logicalId: "review",
          content: "Immutable prompt",
        },
      ],
      inputs: [],
    },
    state: effective.states.review,
  };
  return {
    root,
    definitions: { load: () => Promise.resolve(loaded) },
  };
}

async function result(
  launch: TaskLaunch,
  value: unknown = { outcome: "approved", documents: [] },
): Promise<void> {
  await writeFile(launch.resultPath, `${JSON.stringify(value)}\n`);
}

const succeed: Behavior = { run: (launch) => result(launch) };
const fail = (message: string): Behavior => ({
  run: () =>
    Promise.reject(
      new TaskExecutorError(message, {
        stdout: `stdout: ${message}`,
        stderr: `stderr: ${message}`,
      }),
    ),
});
const never: Behavior = { run: () => new Promise(() => {}) };
const retryWait: Wait = (_milliseconds, signal) =>
  signal ? new Promise(() => {}) : Promise.resolve();

async function execute(
  executor: TaskExecutor,
  definitions: ProjectDefinitions,
  wait: Wait = () => new Promise(() => {}),
  now: () => Date = () => new Date("2026-08-11T12:00:00.000Z"),
): Promise<RunRecord> {
  let id = 0;
  return new ExecuteWorkflow(
    definitions,
    new FilesystemRunRepository(),
    executor,
    now,
    () => `id-${++id}`,
    wait,
  ).execute({
    workflowPath: "retry.yaml",
    currentDirectory: "/unused",
    onRunAllocated: () => {},
  });
}

describe("retries and timeouts", () => {
  it("uses max_attempts as a total budget and retains the third failure", async () => {
    const setup = await definition({ maxAttempts: 3, retryDelayMs: 0 });
    const executor = new ScriptedExecutor([
      fail("failure one"),
      fail("failure two"),
      fail("failure three"),
    ]);
    const run = await execute(executor, setup.definitions, retryWait);

    expect(executor.launches).toHaveLength(3);
    expect(normalVisit(run).task.attempts).toHaveLength(3);
    expect(
      normalVisit(run).task.attempts.map((attempt) => attempt.number),
    ).toEqual([1, 2, 3]);
    expect(
      normalVisit(run).task.attempts.map((attempt) => attempt.externalStatus),
    ).toEqual(["stopped", "stopped", "stopped"]);
    expect(run).toMatchObject({
      status: "failed",
      failure: { code: "executor_failed", message: "failure three" },
    });
    expect(normalVisit(run).task.attempts[2].logs).toEqual({
      stdout: "stdout: failure three",
      stderr: "stderr: failure three",
    });
    expect(run.events.at(-2)).toMatchObject({
      type: "retry_exhausted",
      data: { failedAttemptNumber: 3, maxAttempts: 3 },
    });
  });

  it("recovers on the third attempt with fresh control paths and stable visit context", async () => {
    const setup = await definition({ maxAttempts: 3, retryDelayMs: 0 });
    const executor = new ScriptedExecutor([
      {
        run: async (launch) => {
          await writeFile(
            path.join(launch.outputDirectory, "partial-one.md"),
            "one\n",
          );
          await writeFile(
            path.join(launch.projectWorkspace, "source.ts"),
            "preserved\n",
          );
          throw new TaskExecutorError("first failure");
        },
      },
      {
        run: async (launch) => {
          await writeFile(
            path.join(launch.outputDirectory, "partial-two.md"),
            "two\n",
          );
          throw new TaskExecutorError("second failure");
        },
      },
      {
        run: async (launch) => {
          await writeFile(
            path.join(launch.outputDirectory, "final.md"),
            "final\n",
          );
          await result(launch, {
            outcome: "approved",
            documents: ["final.md"],
          });
        },
      },
    ]);
    const run = await execute(executor, setup.definitions, retryWait);

    expect(run.status).toBe("succeeded");
    expect(run.visits).toHaveLength(1);
    expect(normalVisit(run).task.attempts).toHaveLength(3);
    expect(run.documents.map((document) => document.name)).toEqual([
      "final.md",
    ]);
    expect(
      run.events.filter((event) => event.type === "transition_committed"),
    ).toHaveLength(1);
    expect(
      new Set(
        normalVisit(run).task.attempts.map(
          (attempt) => attempt.controlWorkspace,
        ),
      ).size,
    ).toBe(3);
    expect(
      new Set(executor.launches.map((launch) => launch.outputDirectory)).size,
    ).toBe(3);
    expect(executor.launches.map((launch) => launch.contextPath)).toEqual([
      run.visits[0].contextPath,
      run.visits[0].contextPath,
      run.visits[0].contextPath,
    ]);
    expect(executor.launches.map((launch) => launch.instructions)).toEqual([
      "Immutable instructions\n",
      "Immutable instructions\n",
      "Immutable instructions\n",
    ]);
    expect(executor.launches.map((launch) => launch.prompt)).toEqual([
      "Immutable prompt",
      "Immutable prompt",
      "Immutable prompt",
    ]);
    expect(executor.launches.map((launch) => launch.allowedOutcomes)).toEqual([
      ["approved"],
      ["approved"],
      ["approved"],
    ]);
    expect(await readFile(path.join(setup.root, "source.ts"), "utf8")).toBe(
      "preserved\n",
    );
    const context = await readFile(run.visits[0].contextPath, "utf8");
    expect(context).not.toContain("partial-one.md");
    expect(context).not.toContain("partial-two.md");
    expect(context).not.toContain("source.ts");
  });

  it("keeps a pending question active until the ordinary attempt timeout", async () => {
    const setup = await definition({
      attemptTimeoutMs: 200,
      maxAttempts: 1,
      retryDelayMs: 0,
    });
    const wait: Wait = (milliseconds, signal) =>
      signal
        ? new Promise<void>((resolve) => setImmediate(resolve))
        : Promise.resolve();
    const executor = new ScriptedExecutor(
      [
        {
          run: async (_launch, onEvent) => {
            await onEvent?.({
              id: "question-timeout",
              type: "question",
              status: "pending",
              observedAt: "2026-08-11T00:00:00.100Z",
              message: "Still waiting",
            });
            await new Promise(() => {});
          },
        },
      ],
      ["stopped"],
    );

    const run = await execute(executor, setup.definitions, wait);
    const attempt = normalVisit(run).task.attempts[0];

    expect(run).toMatchObject({
      status: "failed",
      failure: { code: "attempt_timeout" },
    });
    expect(attempt.externalEvents).toMatchObject([
      { id: "question-timeout", status: "pending" },
    ]);
    expect(run.events.map((event) => event.type)).toContain(
      "orca_question_observed",
    );
    expect(run.failure?.code).not.toBe("question_failed");
  });

  it.each([
    ["Orca failure", fail("Orca worker failed"), "executor_failed"],
    ["missing result", { run: async () => {} }, "result_missing_or_invalid"],
    [
      "malformed result",
      { run: (launch: TaskLaunch) => writeFile(launch.resultPath, "{broken") },
      "result_missing_or_invalid",
    ],
    [
      "absent outcome",
      { run: (launch: TaskLaunch) => result(launch, { documents: [] }) },
      "outcome_invalid",
    ],
    [
      "invalid outcome",
      {
        run: (launch: TaskLaunch) =>
          result(launch, { outcome: "uncertain", documents: [] }),
      },
      "outcome_invalid",
    ],
    [
      "absent document",
      {
        run: (launch: TaskLaunch) =>
          result(launch, { outcome: "approved", documents: ["missing.md"] }),
      },
      "documents_invalid",
    ],
    [
      "outside document",
      {
        run: (launch: TaskLaunch) =>
          result(launch, { outcome: "approved", documents: ["../outside.md"] }),
      },
      "documents_invalid",
    ],
    [
      "non-Markdown document",
      {
        run: async (launch: TaskLaunch) => {
          await writeFile(
            path.join(launch.outputDirectory, "report.txt"),
            "text\n",
          );
          await result(launch, {
            outcome: "approved",
            documents: ["report.txt"],
          });
        },
      },
      "documents_invalid",
    ],
  ] as const)(
    "retains a typed failure for %s",
    async (_name, behavior, code) => {
      const setup = await definition({ maxAttempts: 1 });
      const run = await execute(
        new ScriptedExecutor([behavior]),
        setup.definitions,
      );
      expect(run.status).toBe("failed");
      expect(run.failure?.code).toBe(code);
      expect(run.failure?.message).toEqual(expect.any(String));
      expect(normalVisit(run).task.attempts[0].failure).toEqual(run.failure);
    },
  );

  it("waits the complete fixed retry delay before the next launch", async () => {
    const setup = await definition({ maxAttempts: 2, retryDelayMs: 250 });
    let time = Date.parse("2026-08-11T12:00:00.000Z");
    const waits: number[] = [];
    const wait: Wait = async (milliseconds, signal) => {
      if (signal) return new Promise(() => {});
      waits.push(milliseconds);
      time += milliseconds;
    };
    const executor = new ScriptedExecutor([fail("temporary"), succeed]);
    const run = await execute(
      executor,
      setup.definitions,
      wait,
      () => new Date(time),
    );

    expect(waits).toEqual([250]);
    const scheduled = run.events.find(
      (event) => event.type === "retry_scheduled",
    )!;
    const completed = run.events.find(
      (event) => event.type === "retry_delay_completed",
    )!;
    const secondLaunch = run.events.filter(
      (event) => event.type === "attempt_launching",
    )[1];
    expect(Date.parse(completed.at) - Date.parse(scheduled.at)).toBe(250);
    expect(Date.parse(secondLaunch.at)).toBeGreaterThanOrEqual(
      Date.parse(completed.at),
    );
  });

  it.each([
    ["confirmed cancellation", ["stopped"]],
    ["still active before stopping", ["active", "active", "stopped"]],
  ] as const)("retries a timeout after %s", async (_name, statuses) => {
    const setup = await definition({
      attemptTimeoutMs: 200,
      maxAttempts: 2,
      retryDelayMs: 0,
    });
    let timeoutCalls = 0;
    const wait: Wait = async (milliseconds, signal) => {
      if (signal) {
        timeoutCalls += 1;
        if (timeoutCalls === 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          return;
        }
        return new Promise(() => {});
      }
      expect([0, 100]).toContain(milliseconds);
    };
    const executor = new ScriptedExecutor([never, succeed], [...statuses]);
    const run = await execute(executor, setup.definitions, wait);

    expect(run.status).toBe("succeeded");
    expect(executor.cancellations).toHaveLength(1);
    expect(executor.reconciliations).toEqual(statuses);
    expect(executor.launches).toHaveLength(2);
    expect(executor.maxActive).toBe(1);
    expect(normalVisit(run).task.attempts[0]).toMatchObject({
      status: "failed",
      failure: { code: "attempt_timeout" },
      reconciliation: { observations: statuses.map((status) => ({ status })) },
      externalStatus: "stopped",
    });
    expect(
      run.events.filter(
        (event) => event.type === "reconciliation_wait_started",
      ),
    ).toHaveLength(statuses.length - 1);
  });

  it.each(["active", "unknown"] as const)(
    "fails safely without a duplicate when external state stays %s",
    async (externalStatus) => {
      const setup = await definition({
        attemptTimeoutMs: 200,
        maxAttempts: 3,
        retryDelayMs: 0,
      });
      let timeoutCalls = 0;
      const wait: Wait = async (_milliseconds, signal) => {
        if (signal) {
          timeoutCalls += 1;
          if (timeoutCalls === 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            return;
          }
          return new Promise(() => {});
        }
      };
      const executor = new ScriptedExecutor(
        [never],
        [externalStatus, externalStatus, externalStatus],
      );
      const run = await execute(executor, setup.definitions, wait);

      expect(run).toMatchObject({
        status: "failed",
        failure: { code: "external_execution_uncertain" },
      });
      expect(executor.launches).toHaveLength(1);
      expect(executor.cancellations).toHaveLength(1);
      expect(normalVisit(run).task.attempts).toHaveLength(1);
      expect(normalVisit(run).task.attempts[0].failure).toEqual(run.failure);
      expect(normalVisit(run).task.attempts[0].externalStatus).toBe(
        externalStatus,
      );
      expect(
        run.events.find((event) => event.type === "retry_suppressed"),
      ).toMatchObject({
        data: { reason: "external_execution_uncertain" },
      });
    },
  );
});
