import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InspectRuns } from "../src/application/use-cases/inspect-runs.js";
import type { RunRecord } from "../src/domain/execution/run.js";
import { RunPresenter } from "../src/infrastructure/inbound/cli/run-presenter.js";
import { FilesystemRunRepository } from "../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";
import type { EffectiveExecutionDefinition } from "../src/ports/project-definitions.js";

const now = () => new Date("2026-08-11T12:00:30.000Z");

function definition(): EffectiveExecutionDefinition {
  const policies = {
    attemptTimeoutMs: 60_000,
    maxAttempts: 3,
    retryDelayMs: 5_000,
    workflowTimeoutMs: 3_600_000,
    maxStateVisits: 10,
    maxTransitions: 100,
    maxConcurrency: 2,
    controllerLeaseMs: 60_000,
  };
  const work = (id: string) => ({
    id,
    agent: {
      id: `${id}-agent`,
      instructions: id,
      runtime: "codex" as const,
    },
    prompt: id,
    policies,
  });
  return {
    workflowId: "observable",
    executorType: "orca",
    workspaceMode: "direct",
    agents: {},
    policies,
    initialState: "fan_out",
    states: {
      fan_out: {
        id: "fan_out",
        type: "parallel",
        tasks: {
          active: work("active"),
          queued: work("queued"),
          succeeded: work("succeeded"),
          failed: work("failed"),
        },
        outcomes: { succeeded: "$succeeded", failed: "$failed" },
        policies,
        effectiveMaxConcurrency: 2,
      },
    },
  };
}

async function createRun(
  root: string,
  id: string,
  createdAt: string,
  overrides: Partial<RunRecord> = {},
): Promise<{ repository: FilesystemRunRepository; run: RunRecord }> {
  await writeFile(path.join(root, "happy-machine.yaml"), "version: 1\n");
  const repository = new FilesystemRunRepository();
  const effective = definition();
  const snapshot = await repository.createSnapshot({
    runId: id,
    projectRoot: root,
    workflowId: effective.workflowId,
    source: {
      effectiveDefinition: effective,
      artifacts: [
        { kind: "workflow", logicalId: "workflow", content: "observable\n" },
      ],
      inputs: [],
    },
  });
  const run: RunRecord = {
    id,
    workflowId: effective.workflowId,
    workflowPath: path.join(root, "workflow.yaml"),
    projectRoot: root,
    definitionSnapshot: snapshot.record,
    status: "running",
    controllerStatus: "attached",
    createdAt,
    deadlineAt: "2026-08-11T13:00:00.000Z",
    transitionCount: 1,
    visits: [],
    documents: [],
    events: [],
    ...overrides,
  };
  await repository.save(run);
  return { repository, run };
}

describe("status and history observability", () => {
  it("renders active, queued, succeeded, and failed task state without mutating a valid lease", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-status-"));
    const { repository, run } = await createRun(
      root,
      "run-status",
      "2026-08-11T12:00:00.000Z",
    );
    const controlled = await repository.acquireControl(
      root,
      run.id,
      "live-controller",
      "2026-08-11T12:00:00.000Z",
    );
    run.controllerLease = controlled.run.controllerLease;
    run.visits.push({
      type: "parallel",
      stateId: "fan_out",
      number: 2,
      contextPath: "/context.md",
      tasks: [
        {
          id: "active",
          status: "running",
          attempts: [
            {
              id: "active-attempt-1",
              number: 1,
              status: "failed",
              startedAt: "2026-08-11T12:00:00.000Z",
              deadlineAt: "2026-08-11T12:01:00.000Z",
              controlWorkspace: "/control/active-1",
              contextPath: "/context.md",
              outputDirectory: "/output/active-1",
              resultPath: "/output/active-1/result.json",
              logs: { stdout: "first try", stderr: "retry me" },
              failure: { code: "executor_failed", message: "retry" },
              documents: [],
            },
            {
              id: "active-attempt",
              number: 2,
              status: "running",
              startedAt: "2026-08-11T12:00:10.000Z",
              deadlineAt: "2026-08-11T12:01:10.000Z",
              controlWorkspace: "/control/active",
              contextPath: "/context.md",
              outputDirectory: "/output/active",
              resultPath: "/output/active/result.json",
              logs: { stdout: "active log", stderr: "" },
              externalEvents: [
                {
                  id: "question-1",
                  type: "question",
                  status: "pending",
                  observedAt: "2026-08-11T12:00:20.000Z",
                  message: "Need approval?",
                },
                {
                  id: "escalation-1",
                  type: "escalation",
                  status: "pending",
                  observedAt: "2026-08-11T12:00:21.000Z",
                  message: "Needs reviewer",
                },
              ],
              documents: [],
            },
          ],
          documents: [],
          workspace: {
            mode: "worktree",
            path: root,
            branch: "happy-machine/run-status/active",
            startingHead: "abc123",
            endingHead: "def456",
            dirty: true,
          },
        },
        {
          id: "queued",
          status: "queued",
          attempts: [],
          documents: [],
          workspace: { mode: "direct", path: root },
        },
        {
          id: "succeeded",
          status: "succeeded",
          outcome: "succeeded",
          attempts: [
            {
              id: "success-attempt",
              number: 1,
              status: "succeeded",
              deadlineAt: "2026-08-11T12:00:40.000Z",
              controlWorkspace: "/control/success",
              contextPath: "/context.md",
              outputDirectory: "/output/success",
              resultPath: "/output/success/result.json",
              logs: { stdout: "ok", stderr: "warning" },
              documents: [],
            },
          ],
          documents: [],
          workspace: { mode: "direct", path: root },
        },
        {
          id: "failed",
          status: "failed",
          failure: { code: "executor_failed", message: "worker failed" },
          attempts: [
            {
              id: "failed-attempt",
              number: 1,
              status: "failed",
              deadlineAt: "2026-08-11T12:00:35.000Z",
              controlWorkspace: "/control/failed",
              contextPath: "/context.md",
              outputDirectory: "/output/failed",
              resultPath: "/output/failed/result.json",
              logs: { stdout: "", stderr: "failed" },
              failure: { code: "executor_failed", message: "worker failed" },
              documents: [],
            },
          ],
          documents: [],
          workspace: { mode: "direct", path: root },
        },
      ],
    });
    run.events.push(
      {
        sequence: 1,
        type: "transition_committed",
        at: "2026-08-11T11:59:59.000Z",
        data: { outcome: "ready", target: "fan_out" },
      },
      {
        sequence: 2,
        type: "retry_scheduled",
        at: "2026-08-11T12:00:05.000Z",
        data: {
          taskId: "active",
          failedAttemptNumber: 1,
          delayMs: 5_000,
        },
      },
    );
    await repository.saveControlled(
      run,
      "live-controller",
      controlled.fencingToken,
    );
    const before = JSON.stringify((await repository.load(root, run.id)).run);

    const result = await new InspectRuns(repository, now).status(root, run.id);
    const output = new RunPresenter().status(result);

    expect(output).toContain("Status: running");
    expect(output).toContain("Controller: attached");
    expect(output).toContain("Current: fan_out visit 2 (parallel)");
    expect(output).toContain("active: active");
    expect(output).toContain("queued: queued");
    expect(output).toContain("succeeded: succeeded");
    expect(output).toContain("failed: failed");
    expect(output).toContain("question question-1");
    expect(output).toContain(
      "run=run-status state=fan_out visit=2 task=active attempt=2",
    );
    expect(output).toContain("Last outcome: ready");
    expect(output).toBe(
      [
        "Run: run-status",
        "Workflow: observable",
        `Snapshot: ${run.definitionSnapshot.identity}`,
        "Status: running",
        "Terminal reason: none",
        "Cancellation: none",
        "Controller: attached",
        "Lease: valid controller=live-controller token=1 expires=2026-08-11T12:01:00.000Z observed=2026-08-11T12:00:30.000Z",
        "Current: fan_out visit 2 (parallel)",
        "Last outcome: ready",
        "Last transition: fan_out",
        "Tasks:",
        `  active: active workspace=${root} mode=worktree branch=happy-machine/run-status/active starting_head=abc123 ending_head=def456 dirty=true`,
        "    attempt 1: failed; deadline=2026-08-11T12:01:00.000Z; retry=retry_scheduled delay_ms=5000 at=2026-08-11T12:00:05.000Z; external=unknown; executor=none; cancellation=none; workspace=/control/active-1",
        "    attempt 2: running; deadline=2026-08-11T12:01:10.000Z; retry=none; external=unknown; executor=none; cancellation=none; workspace=/control/active",
        `  queued: queued workspace=${root} mode=direct`,
        "    attempts: none",
        `  succeeded: succeeded workspace=${root} mode=direct`,
        "    attempt 1: succeeded; deadline=2026-08-11T12:00:40.000Z; retry=none; external=unknown; executor=none; cancellation=none; workspace=/control/success",
        `  failed: failed workspace=${root} mode=direct`,
        "    attempt 1: failed; deadline=2026-08-11T12:00:35.000Z; retry=none; external=unknown; executor=none; cancellation=none; workspace=/control/failed",
        "Pending external events:",
        '  question question-1: state=fan_out visit=2 task=active attempt=2 observed=2026-08-11T12:00:20.000Z message="Need approval?"',
        '  escalation escalation-1: state=fan_out visit=2 task=active attempt=2 observed=2026-08-11T12:00:21.000Z message="Needs reviewer"',
        "Cancellation executions:",
        "  none",
        "Logs:",
        "  run=run-status state=fan_out visit=2 task=active attempt=1 stdout_bytes=9 stderr_bytes=8",
        "  run=run-status state=fan_out visit=2 task=active attempt=2 stdout_bytes=10 stderr_bytes=0",
        "  run=run-status state=fan_out visit=2 task=succeeded attempt=1 stdout_bytes=2 stderr_bytes=7",
        "  run=run-status state=fan_out visit=2 task=failed attempt=1 stdout_bytes=0 stderr_bytes=6",
      ].join("\n"),
    );
    process.env.HAPPY_MACHINE_HIDDEN_SECRET = "must-not-appear";
    expect(output).not.toContain("must-not-appear");
    expect(
      new RunPresenter().history(
        await new InspectRuns(repository, now).history(root, run.id),
      ),
    ).not.toContain("must-not-appear");
    delete process.env.HAPPY_MACHINE_HIDDEN_SECRET;
    expect(JSON.stringify((await repository.load(root, run.id)).run)).toBe(
      before,
    );
  });

  it.each([
    ["running", "detached"],
    ["succeeded", "succeeded"],
    ["failed", "failed"],
    ["canceled", "canceled"],
  ] as const)("renders stored run status %s as %s", async (status, visible) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-status-kind-"));
    const { repository, run } = await createRun(
      root,
      `run-${status}`,
      "2026-08-11T10:00:00.000Z",
      { status, controllerStatus: "detached" },
    );

    const output = new RunPresenter().status(
      await new InspectRuns(repository, now).status(root, run.id),
    );
    expect(output).toContain(`Status: ${visible}`);
  });

  it("shows terminal failure cause and causal history in stable sequence order", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-history-"));
    const { repository, run } = await createRun(
      root,
      "run-failed",
      "2026-08-11T10:00:00.000Z",
      {
        status: "failed",
        controllerStatus: "detached",
        failure: { code: "workflow_timeout", message: "deadline expired" },
      },
    );
    run.events = [
      {
        sequence: 5,
        type: "run_terminal",
        at: "2026-08-11T10:03:00.000Z",
        data: { reason: "workflow_timeout" },
      },
      {
        sequence: 1,
        type: "run_created",
        at: "2026-08-11T10:00:00.000Z",
        data: { snapshot: run.definitionSnapshot.identity },
      },
      {
        sequence: 2,
        type: "retry_scheduled",
        at: "2026-08-11T10:01:00.000Z",
        data: { reason: "executor_failed" },
      },
      {
        sequence: 3,
        type: "controller_lease_released",
        at: "2026-08-11T10:01:30.000Z",
        data: { reason: "detached" },
      },
      {
        sequence: 4,
        type: "controller_lease_recovered",
        at: "2026-08-11T10:02:00.000Z",
        data: { reason: "resumed" },
      },
    ];
    await repository.save(run);
    const inspect = new InspectRuns(repository, now);

    expect(
      new RunPresenter().status(await inspect.status(root, run.id)),
    ).toContain("Terminal reason: workflow_timeout: deadline expired");
    const history = new RunPresenter().history(
      await inspect.history(root, run.id),
    );
    expect(history.indexOf("1 2026")).toBeLessThan(history.indexOf("2 2026"));
    expect(history.indexOf("2 2026")).toBeLessThan(history.indexOf("3 2026"));
    expect(history.indexOf("3 2026")).toBeLessThan(history.indexOf("4 2026"));
    expect(history.indexOf("4 2026")).toBeLessThan(history.indexOf("5 2026"));
    expect(history).toContain("controller_lease_released");
    expect(history).toContain("controller_lease_recovered");
    expect(history).toContain(run.definitionSnapshot.identity);
  });

  it("lists only discovered-project runs newest first", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-list-"));
    const nested = path.join(root, "nested", "directory");
    await mkdir(nested, { recursive: true });
    const first = await createRun(root, "run-old", "2026-08-11T09:00:00.000Z");
    await createRun(root, "run-new", "2026-08-11T11:00:00.000Z");
    const other = await mkdtemp(path.join(os.tmpdir(), "happy-other-"));
    await createRun(other, "run-other", "2026-08-11T12:00:00.000Z");

    const result = await new InspectRuns(first.repository, now).history(nested);
    const output = new RunPresenter().history(result);
    expect(output.indexOf("run-new")).toBeLessThan(output.indexOf("run-old"));
    expect(output).not.toContain("run-other");
  });

  it("renders document provenance and the all-settled parallel join summary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-join-history-"));
    const { repository, run } = await createRun(
      root,
      "run-join",
      "2026-08-11T10:00:00.000Z",
    );
    run.events = [
      {
        sequence: 1,
        type: "document_committed",
        at: "2026-08-11T10:01:00.000Z",
        data: {
          stateId: "fan_out",
          visitNumber: 1,
          taskId: "successful-task",
          internalPath:
            "states/fan_out/visits/1/tasks/successful-task/documents/report.md",
          sha256: "abc123",
        },
      },
      {
        sequence: 2,
        type: "parallel_join_committed",
        at: "2026-08-11T10:02:00.000Z",
        data: {
          outcome: "failed",
          tasks: [
            { id: "successful-task", status: "succeeded", attempts: 1 },
            {
              id: "failed-task",
              status: "failed",
              attempts: 2,
              finalError: { code: "executor_failed" },
            },
          ],
        },
      },
    ];
    await repository.save(run);

    const output = new RunPresenter().history(
      await new InspectRuns(repository, now).history(root, run.id),
    );
    expect(output).toContain("document_committed");
    expect(output).toContain("successful-task/documents/report.md");
    expect(output).toContain("parallel_join_committed");
    expect(output).toContain('"outcome":"failed"');
    expect(output).toContain('"id":"failed-task"');
  });

  it("renders bounded workflow wrapper links and the inverse parent reference", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "happy-submachine-observe-"),
    );
    const { repository, run } = await createRun(
      root,
      "parent-run",
      "2026-08-11T10:00:00.000Z",
    );
    const childId = "child_1234567890abcdef";
    run.visits.push({
      type: "parallel",
      stateId: "fan_out",
      number: 1,
      contextPath: "/context.md",
      tasks: [
        {
          id: "inspect-child",
          status: "failed",
          attempts: [],
          documents: [],
          workspace: { mode: "direct", path: root },
          execution: {
            type: "workflow",
            phase: "failed",
            coordinate: {
              parentRunId: run.id,
              stateId: "fan_out",
              visitNumber: 1,
              taskId: "inspect-child",
            },
            childRunId: childId,
            resolvedWith: { item: "one" },
            evaluationAttempts: [
              {
                id: "evaluation-1",
                number: 1,
                status: "succeeded",
                controlWorkspace: root,
                contextPath: "/evaluation.md",
                outputDirectory: "/output",
                resultPath: "/output/result.json",
                logs: { stdout: "", stderr: "" },
                error: { code: "semantic_failure", message: "review required" },
                documents: [],
              },
            ],
            result: {
              id: "inspect-child",
              childRunId: childId,
              status: "failed",
              outputs: {},
              documents: [],
              error: { code: "semantic_failure", message: "review required" },
            },
          },
        },
      ],
    });
    run.events.push({
      sequence: 1,
      type: "child_run_settled",
      at: "2026-08-11T10:01:00.000Z",
      data: {
        parentRunId: run.id,
        stateId: "fan_out",
        visitNumber: 1,
        taskId: "inspect-child",
        childRunId: childId,
        status: "failed",
      },
    });
    await repository.save(run);

    const status = new RunPresenter().status(
      await new InspectRuns(repository, now).status(root, run.id),
    );
    expect(status).toContain(
      `inspect-child type=workflow phase=failed child_run=${childId} attempts=1 outcome=failed`,
    );
    expect(status).toContain(
      'error={"code":"semantic_failure","message":"review required"}',
    );
    const history = new RunPresenter().history(
      await new InspectRuns(repository, now).history(root, run.id),
    );
    expect(history).toContain(
      `task=inspect-child child_run=${childId} phase=failed`,
    );
    expect(history).not.toContain("evaluation-1");

    const child = {
      ...run,
      id: childId,
      parent: {
        runId: run.id,
        stateId: "fan_out",
        visitNumber: 1,
        taskId: "inspect-child",
      },
      visits: [],
      events: [],
    };
    expect(
      new RunPresenter().status({
        run: child,
        observedAt: now().toISOString(),
        leaseValid: false,
      }),
    ).toContain(
      `Parent: run=${run.id} state=fan_out visit=1 task=inspect-child`,
    );
  });
});
