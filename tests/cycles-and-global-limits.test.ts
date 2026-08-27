import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExecuteWorkflow,
  type Wait,
} from "../src/application/use-cases/execute-workflow.js";
import {
  evaluateStateVisitLimit,
  evaluateTransitionLimit,
  evaluateWorkflowDeadline,
} from "../src/domain/execution/run.js";
import type {
  ExecutorReferences,
  RunRecord,
} from "../src/domain/execution/run.js";
import { FilesystemProjectDefinitions } from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";
import { FilesystemRunRepository } from "../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";
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
import { TaskExecutorError } from "../src/ports/task-executor.js";

class ControlledClock {
  constructor(private milliseconds: number) {}

  now = (): Date => new Date(this.milliseconds);

  advance(milliseconds: number): void {
    this.milliseconds += milliseconds;
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 2_000; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

type Behavior = (
  launch: TaskLaunch,
  call: number,
  executor: ScriptedExecutor,
) => Promise<void>;

class ScriptedExecutor implements TaskExecutor {
  readonly launches: TaskLaunch[] = [];
  readonly cancellations: ExecutorReferences[] = [];
  readonly reconciliations: string[] = [];

  constructor(
    private readonly behavior: Behavior,
    private readonly statuses: Array<"active" | "stopped" | "unknown"> = [
      "stopped",
    ],
  ) {}

  async execute(
    launch: TaskLaunch,
    onStarted: (references: ExecutorReferences) => Promise<void>,
  ): Promise<TaskExecution> {
    const call = this.launches.length + 1;
    this.launches.push(structuredClone(launch));
    const references = {
      runId: `orca-run-${call}`,
      taskId: `orca-task-${call}`,
      dispatchId: `dispatch-${call}`,
      terminalHandle: `terminal-${call}`,
    };
    await onStarted(references);
    await this.behavior(launch, call, this);
    return {
      references,
      logs: { stdout: `stdout ${call}`, stderr: `stderr ${call}` },
    };
  }

  cancel(references: ExecutorReferences): Promise<void> {
    this.cancellations.push(references);
    return Promise.resolve();
  }

  reconcile(): Promise<"active" | "stopped" | "unknown"> {
    const status = this.statuses.shift() ?? "unknown";
    this.reconciliations.push(status);
    return Promise.resolve(status);
  }
}

function policies(
  overrides: Partial<EffectivePolicies> = {},
): EffectivePolicies {
  return {
    attemptTimeoutMs: 1_000,
    maxAttempts: 3,
    retryDelayMs: 0,
    workflowTimeoutMs: 60_000,
    maxStateVisits: 10,
    maxTransitions: 100,
    maxConcurrency: 4,
    controllerLeaseMs: 30_000,
    ...overrides,
  };
}

async function staticDefinitions(options: {
  stateOutcomes: Record<string, string>;
  policyOverrides?: Partial<EffectivePolicies>;
}): Promise<{ root: string; definitions: ProjectDefinitions }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-limits-"));
  await mkdir(path.join(root, "workflows"));
  const workflowPath = path.join(root, "workflows", "limits.yaml");
  await writeFile(workflowPath, "limits workflow\n");
  const effectivePolicies = policies(options.policyOverrides);
  const state: StateDefinition = {
    id: "work",
    type: "agent",
    agent: {
      id: "worker",
      instructions: "Work within global limits",
      runtime: "codex",
    },
    prompt: "work",
    policies: effectivePolicies,
    attemptTimeoutMs: effectivePolicies.attemptTimeoutMs,
    outcomes: options.stateOutcomes,
  };
  const effective: EffectiveExecutionDefinition = {
    workflowId: "limits-workflow",
    executorType: "orca",
    workspaceMode: "direct",
    agents: {},
    policies: effectivePolicies,
    states: { work: state },
    initialState: "work",
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
          content: "limits workflow\n",
        },
      ],
      inputs: [],
    },
    state,
  };
  return {
    root,
    definitions: { load: () => Promise.resolve(loaded) },
  };
}

async function parallelDefinitions(): Promise<{
  definitions: ProjectDefinitions;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-limit-parallel-"));
  await mkdir(path.join(root, "workflows"));
  const workflowPath = path.join(root, "workflows", "parallel.yaml");
  await writeFile(workflowPath, "parallel deadline\n");
  const effectivePolicies = policies({
    workflowTimeoutMs: 100,
    attemptTimeoutMs: 1_000,
    maxAttempts: 1,
    maxConcurrency: 2,
  });
  const tasks = Object.fromEntries(
    ["one", "two", "queued"].map((id) => {
      const definition: ParallelTaskDefinition = {
        id,
        agent: {
          id: `${id}-agent`,
          instructions: `Instructions for ${id}`,
          runtime: "codex",
        },
        prompt: id,
        policies: effectivePolicies,
      };
      return [id, definition];
    }),
  );
  const state: StateDefinition = {
    id: "fan_out",
    type: "parallel",
    tasks,
    outcomes: { succeeded: "$succeeded", failed: "$failed" },
    policies: effectivePolicies,
    effectiveMaxConcurrency: 2,
  };
  const effective: EffectiveExecutionDefinition = {
    workflowId: "parallel-deadline",
    executorType: "orca",
    workspaceMode: "direct",
    agents: {},
    policies: effectivePolicies,
    states: { fan_out: state },
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
          content: "parallel deadline\n",
        },
      ],
      inputs: [],
    },
    state,
  };
  return { definitions: { load: () => Promise.resolve(loaded) } };
}

async function result(
  launch: TaskLaunch,
  outcome: string,
  documents: Array<{ path: string; content: string }> = [],
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
    })}\n`,
  );
}

const normalWait: Wait = (_milliseconds, signal) =>
  signal ? new Promise(() => {}) : Promise.resolve();

async function execute(options: {
  definitions: ProjectDefinitions;
  executor: TaskExecutor;
  clock?: ControlledClock;
  wait?: Wait;
  repository?: RunRepository;
  workflowPath?: string;
  currentDirectory?: string;
}): Promise<RunRecord> {
  let id = 0;
  const clock = options.clock ?? new ControlledClock(Date.UTC(2026, 7, 11));
  return new ExecuteWorkflow(
    options.definitions,
    options.repository ?? new FilesystemRunRepository(),
    options.executor,
    clock.now,
    () => `id-${++id}`,
    options.wait ?? normalWait,
  ).execute({
    workflowPath: options.workflowPath ?? "limits.yaml",
    currentDirectory: options.currentDirectory ?? "/unused",
    onRunAllocated: () => {},
  });
}

async function cycleProject(): Promise<{ root: string; workflow: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-cycle-e2e-"));
  await mkdir(path.join(root, "agents"));
  await mkdir(path.join(root, "workflows"));
  await writeFile(path.join(root, "agents", "worker.md"), "# Worker\n");
  await writeFile(
    path.join(root, "happy-machine.yaml"),
    `version: 1
agents:
  worker:
    instructions: agents/worker.md
    runtime: codex
defaults:
  attempt_timeout: 5s
  max_attempts: 1
  retry_delay: 1ms
  workflow_timeout: 1h
  max_state_visits: 3
  max_transitions: 6
`,
  );
  const workflow = path.join(root, "workflows", "cycle.yaml");
  await writeFile(
    workflow,
    `version: 1
id: cycle
initial_state: draft
states:
  draft:
    type: agent
    agent: worker
    prompt: draft
    outcomes:
      completed: review
  review:
    type: agent
    agent: worker
    prompt: review
    outcomes:
      needs_revision: draft
      approved: $succeeded
`,
  );
  return { root, workflow };
}

function limitEvents(run: RunRecord, limit: string) {
  return run.events.filter(
    (event) => event.type === "limit_evaluated" && event.data.limit === limit,
  );
}

describe("cycles and global limits", () => {
  it("executes a draft/review cycle with a fresh second-draft context", async () => {
    const setup = await cycleProject();
    let secondDraftContext = "";
    const calls = new Map<string, number>();
    const executor = new ScriptedExecutor(async (launch) => {
      const call = (calls.get(launch.prompt) ?? 0) + 1;
      calls.set(launch.prompt, call);
      if (launch.prompt === "draft") {
        if (call === 2)
          secondDraftContext = await readFile(launch.contextPath, "utf8");
        await result(launch, "completed", [
          {
            path: `draft-${call}.md`,
            content: `draft version ${call}\n`,
          },
        ]);
      } else {
        await result(
          launch,
          call === 1 ? "needs_revision" : "approved",
          call === 1
            ? [{ path: "feedback.md", content: "review feedback\n" }]
            : [],
        );
      }
    });
    const run = await execute({
      definitions: new FilesystemProjectDefinitions(),
      executor,
      workflowPath: setup.workflow,
      currentDirectory: setup.root,
    });

    expect(run.status).toBe("succeeded");
    expect(run.transitionCount).toBe(4);
    expect(run.visits.map((visit) => [visit.stateId, visit.number])).toEqual([
      ["draft", 1],
      ["review", 1],
      ["draft", 2],
      ["review", 2],
    ]);
    expect(secondDraftContext).toContain("draft-1.md");
    expect(secondDraftContext).toContain("feedback.md");
    expect(secondDraftContext).not.toContain("draft-2.md");
  });

  it("creates distinct visits for a self-loop and permits exactly N visits", async () => {
    const setup = await staticDefinitions({
      stateOutcomes: { again: "work", done: "$succeeded" },
      policyOverrides: { maxStateVisits: 2, maxTransitions: 2 },
    });
    const executor = new ScriptedExecutor((launch, call) =>
      result(launch, call === 1 ? "again" : "done"),
    );
    const run = await execute({ definitions: setup.definitions, executor });

    expect(run.status).toBe("succeeded");
    expect(run.transitionCount).toBe(2);
    expect(run.visits.map((visit) => visit.number)).toEqual([1, 2]);
    expect(executor.launches).toHaveLength(2);
  });

  it("rejects visit N+1 before launching and records the causal evaluation", async () => {
    const setup = await staticDefinitions({
      stateOutcomes: { again: "work" },
      policyOverrides: { maxStateVisits: 2, maxTransitions: 10 },
    });
    const executor = new ScriptedExecutor((launch) => result(launch, "again"));
    const run = await execute({ definitions: setup.definitions, executor });

    expect(run).toMatchObject({
      status: "failed",
      failure: { code: "max_state_visits_exceeded" },
      transitionCount: 2,
    });
    expect(run.visits).toHaveLength(2);
    expect(executor.launches).toHaveLength(2);
    expect(limitEvents(run, "max_state_visits").at(-1)?.data).toMatchObject({
      effectiveValue: 2,
      observedValue: 3,
      decision: "exceeded",
      terminalCause: "max_state_visits_exceeded",
    });
  });

  it("allows terminal edge N and rejects transition N+1 without routing", async () => {
    const allowedSetup = await staticDefinitions({
      stateOutcomes: { again: "work", done: "$succeeded" },
      policyOverrides: { maxTransitions: 2 },
    });
    const allowed = await execute({
      definitions: allowedSetup.definitions,
      executor: new ScriptedExecutor((launch, call) =>
        result(launch, call === 1 ? "again" : "done"),
      ),
    });
    expect(allowed).toMatchObject({
      status: "succeeded",
      transitionCount: 2,
      terminalTarget: "$succeeded",
    });

    const deniedSetup = await staticDefinitions({
      stateOutcomes: { again: "work", done: "$succeeded" },
      policyOverrides: { maxTransitions: 1 },
    });
    const executor = new ScriptedExecutor((launch, call) =>
      result(launch, call === 1 ? "again" : "done"),
    );
    const denied = await execute({
      definitions: deniedSetup.definitions,
      executor,
    });
    const finalVisit = denied.visits[1];

    expect(denied).toMatchObject({
      status: "failed",
      failure: { code: "max_transitions_exceeded" },
      transitionCount: 1,
    });
    expect(finalVisit).not.toHaveProperty("outcome");
    expect(finalVisit).not.toHaveProperty("target");
    expect(denied).not.toHaveProperty("terminalTarget");
    expect(executor.launches).toHaveLength(2);
    expect(limitEvents(denied, "max_transitions").at(-1)?.data).toMatchObject({
      effectiveValue: 1,
      observedValue: 2,
      decision: "exceeded",
      terminalCause: "max_transitions_exceeded",
    });
  });

  it("counts retries as attempts rather than visits", async () => {
    const setup = await staticDefinitions({
      stateOutcomes: { done: "$succeeded" },
      policyOverrides: { maxAttempts: 3, maxStateVisits: 1 },
    });
    const executor = new ScriptedExecutor((launch, call) => {
      if (call < 3)
        return Promise.reject(new TaskExecutorError(`failure ${call}`));
      return result(launch, "done");
    });
    const run = await execute({ definitions: setup.definitions, executor });
    const visit = run.visits[0];
    if (visit.type !== "agent") throw new Error("expected agent visit");

    expect(run.status).toBe("succeeded");
    expect(run.visits).toHaveLength(1);
    expect(visit.task.attempts).toHaveLength(3);
    expect(limitEvents(run, "max_state_visits")).toHaveLength(1);
  });

  it("cancels and reconciles an active attempt at the attached workflow deadline", async () => {
    const clock = new ControlledClock(Date.UTC(2026, 7, 11));
    const setup = await staticDefinitions({
      stateOutcomes: { done: "$succeeded" },
      policyOverrides: { workflowTimeoutMs: 100, attemptTimeoutMs: 1_000 },
    });
    const executor = new ScriptedExecutor(() => new Promise(() => {}));
    const deadlineWait: Wait = (milliseconds, signal) => {
      if (!signal) return Promise.resolve();
      clock.advance(milliseconds);
      return Promise.resolve();
    };
    const run = await execute({
      definitions: setup.definitions,
      executor,
      clock,
      wait: deadlineWait,
    });
    const visit = run.visits[0];
    if (visit.type !== "agent") throw new Error("expected agent visit");
    const attempt = visit.task.attempts[0];

    expect(run).toMatchObject({
      status: "failed",
      failure: { code: "workflow_timeout" },
      transitionCount: 0,
    });
    expect(executor.cancellations).toHaveLength(1);
    expect(executor.reconciliations).toEqual(["stopped"]);
    expect(attempt).toMatchObject({
      status: "failed",
      failure: { code: "workflow_timeout" },
      externalStatus: "stopped",
    });
    expect(typeof attempt.reconciliation?.confirmedStoppedAt).toBe("string");
    expect(limitEvents(run, "workflow_timeout").at(-1)?.data).toMatchObject({
      phase: "active_attempt",
      decision: "exceeded",
      terminalCause: "workflow_timeout",
      effectiveDeadline: run.deadlineAt,
    });
  });

  it("keeps workflow_timeout causal when reconciliation cannot confirm stop", async () => {
    const clock = new ControlledClock(Date.UTC(2026, 7, 11));
    const setup = await staticDefinitions({
      stateOutcomes: { done: "$succeeded" },
      policyOverrides: { workflowTimeoutMs: 25, attemptTimeoutMs: 200 },
    });
    const executor = new ScriptedExecutor(
      () => new Promise(() => {}),
      Array.from({ length: 10 }, () => "unknown" as const),
    );
    const wait: Wait = (milliseconds, signal) => {
      if (signal) clock.advance(milliseconds);
      return Promise.resolve();
    };
    const run = await execute({
      definitions: setup.definitions,
      executor,
      clock,
      wait,
    });
    const visit = run.visits[0];
    if (visit.type !== "agent") throw new Error("expected agent visit");

    expect(run.failure?.code).toBe("workflow_timeout");
    expect(visit.task.attempts[0]).toMatchObject({
      status: "failed",
      failure: { code: "workflow_timeout" },
      externalStatus: "unknown",
    });
    expect(
      visit.task.attempts[0].reconciliation?.observations.length,
    ).toBeGreaterThan(1);
  });

  it("cancels active parallel tasks and never schedules queued work after the deadline", async () => {
    const clock = new ControlledClock(Date.UTC(2026, 7, 11));
    const setup = await parallelDefinitions();
    const executor = new ScriptedExecutor(
      () => new Promise(() => {}),
      ["stopped", "stopped"],
    );
    let releaseDeadline!: () => void;
    const deadline = new Promise<void>((resolve) => {
      releaseDeadline = resolve;
    });
    let advanced = false;
    const wait: Wait = (milliseconds, signal) => {
      if (!signal) return Promise.resolve();
      return deadline.then(() => {
        if (!advanced) {
          advanced = true;
          clock.advance(milliseconds);
        }
      });
    };
    const execution = execute({
      definitions: setup.definitions,
      executor,
      clock,
      wait,
    });
    await eventually(() => executor.launches.length === 2);
    releaseDeadline();
    const run = await execution;
    const visit = run.visits[0];
    if (visit.type !== "parallel") throw new Error("expected parallel visit");

    expect(run.failure?.code).toBe("workflow_timeout");
    expect(executor.launches).toHaveLength(2);
    expect(executor.cancellations).toHaveLength(2);
    expect(visit.tasks.filter((task) => task.status === "failed")).toHaveLength(
      2,
    );
    expect(visit.tasks.filter((task) => task.status === "queued")).toHaveLength(
      1,
    );
  });

  it("counts retry delay time toward workflow_timeout and launches no retry", async () => {
    const clock = new ControlledClock(Date.UTC(2026, 7, 11));
    const setup = await staticDefinitions({
      stateOutcomes: { done: "$succeeded" },
      policyOverrides: {
        workflowTimeoutMs: 50,
        retryDelayMs: 100,
        attemptTimeoutMs: 1_000,
      },
    });
    const executor = new ScriptedExecutor(() =>
      Promise.reject(new TaskExecutorError("retry me")),
    );
    const delayWait: Wait = (milliseconds, signal) => {
      if (signal) return new Promise(() => {});
      clock.advance(milliseconds);
      return Promise.resolve();
    };
    const run = await execute({
      definitions: setup.definitions,
      executor,
      clock,
      wait: delayWait,
    });

    expect(run).toMatchObject({
      status: "failed",
      failure: { code: "workflow_timeout" },
    });
    expect(executor.launches).toHaveLength(1);
    expect(limitEvents(run, "workflow_timeout").at(-1)?.data.phase).toBe(
      "retry_delay_completed",
    );
  });

  it("counts time while an executor is awaiting a question", async () => {
    const clock = new ControlledClock(Date.UTC(2026, 7, 11));
    const setup = await staticDefinitions({
      stateOutcomes: { done: "$succeeded" },
      policyOverrides: { workflowTimeoutMs: 75, attemptTimeoutMs: 1_000 },
    });
    const executor = new ScriptedExecutor(() => new Promise(() => {}));
    const wait: Wait = (milliseconds, signal) => {
      if (!signal) return Promise.resolve();
      clock.advance(milliseconds);
      return Promise.resolve();
    };
    const run = await execute({
      definitions: setup.definitions,
      executor,
      clock,
      wait,
    });

    expect(run.failure?.code).toBe("workflow_timeout");
    expect(executor.cancellations).toHaveLength(1);
    expect(executor.launches).toHaveLength(1);
  });

  it("detects a deadline crossed during a detached interval before scheduling", async () => {
    const clock = new ControlledClock(Date.UTC(2026, 7, 11));
    const setup = await staticDefinitions({
      stateOutcomes: { done: "$succeeded" },
      policyOverrides: { workflowTimeoutMs: 100 },
    });
    const filesystem = new FilesystemRunRepository();
    let firstSave = true;
    const repository: RunRepository = {
      createSnapshot: (request) => filesystem.createSnapshot(request),
      prepareVisitContext: (run) => filesystem.prepareVisitContext(run),
      prepareAttempt: (run, visit, task, attemptNumber) =>
        filesystem.prepareAttempt(run, visit, task, attemptNumber),
      readResult: (resultPath, outputDirectory, outcomes) =>
        filesystem.readResult(resultPath, outputDirectory, outcomes),
      stageDocuments: (run, visit, task, outputDirectory, names) =>
        filesystem.stageDocuments(run, visit, task, outputDirectory, names),
      save: async (run) => {
        await filesystem.save(run);
        if (firstSave) {
          firstSave = false;
          clock.advance(101);
        }
      },
    };
    const executor = new ScriptedExecutor((launch) => result(launch, "done"));
    const run = await execute({
      definitions: setup.definitions,
      executor,
      clock,
      repository,
    });

    expect(run).toMatchObject({
      status: "failed",
      failure: { code: "workflow_timeout" },
      visits: [],
      transitionCount: 0,
    });
    expect(executor.launches).toHaveLength(0);
    expect(limitEvents(run, "workflow_timeout").at(-1)?.data).toMatchObject({
      phase: "state_entry",
      decision: "exceeded",
    });
  });

  it("exposes pure inclusive limit checks for future resumed controllers", () => {
    expect(evaluateStateVisitLimit(2, 2)).toMatchObject({ allowed: true });
    expect(evaluateStateVisitLimit(2, 3)).toMatchObject({
      allowed: false,
      terminalCause: "max_state_visits_exceeded",
    });
    expect(evaluateTransitionLimit(4, 4)).toMatchObject({ allowed: true });
    expect(evaluateTransitionLimit(4, 5)).toMatchObject({
      allowed: false,
      terminalCause: "max_transitions_exceeded",
    });
    expect(
      evaluateWorkflowDeadline(
        "2026-08-11T00:00:00.100Z",
        "2026-08-11T00:00:00.100Z",
      ),
    ).toMatchObject({
      allowed: false,
      terminalCause: "workflow_timeout",
    });
  });
});
