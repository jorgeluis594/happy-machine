import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ProjectWorkspaceCoordinator } from "../src/application/services/project-workspace-coordinator.js";
import { CancelWorkflow } from "../src/application/use-cases/cancel-workflow.js";
import { RecoverWorkflow } from "../src/application/use-cases/recover-workflow.js";
import type {
  AttemptRecord,
  ExecutorReferences,
  ParallelVisitRecord,
  RunRecord,
} from "../src/domain/execution/run.js";
import {
  recordWorktree,
  recordWorktreeObservation,
  taskWorkspaceFromWorktree,
} from "../src/domain/execution/run.js";
import { FilesystemProjectDefinitions } from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";
import { GitProjectWorkspaces } from "../src/infrastructure/outbound/project-workspaces/git/git-project-workspaces.js";
import { FilesystemRunRepository } from "../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";
import type { ExecutionDefinition } from "../src/ports/project-definitions.js";
import type {
  RecoveryObservation,
  TaskExecution,
  TaskExecutor,
  TaskLaunch,
} from "../src/ports/task-executor.js";

const executeFile = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await executeFile("git", ["-C", root, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function project(workflow: string): Promise<{
  root: string;
  workflowPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-recover-worktree-"));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "happy-machine@example.com");
  await git(root, "config", "user.name", "Happy Machine Tests");
  await mkdir(path.join(root, "agents"));
  await mkdir(path.join(root, "workflows"));
  await writeFile(
    path.join(root, "happy-machine.yaml"),
    `version: 1
workspace:
  mode: worktree
agents:
  worker:
    instructions: agents/worker.md
    runtime: codex
defaults:
  attempt_timeout: 5s
  max_attempts: 1
  retry_delay: 1ms
  workflow_timeout: 5m
  max_concurrency: 3
  controller_lease: 30s
`,
  );
  await writeFile(path.join(root, "agents", "worker.md"), "# Worker\n");
  const workflowPath = path.join(root, "workflows", "workflow.yaml");
  await writeFile(workflowPath, workflow);
  await writeFile(path.join(root, "tracked.txt"), "initial\n");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "initial");
  return { root, workflowPath };
}

async function detachedRun(
  setup: { root: string; workflowPath: string },
  runId: string,
): Promise<{
  definition: ExecutionDefinition;
  repository: FilesystemRunRepository;
  run: RunRecord;
}> {
  const definition = await new FilesystemProjectDefinitions().load(
    setup.workflowPath,
    setup.root,
  );
  const repository = new FilesystemRunRepository();
  const snapshot = await repository.createSnapshot({
    runId,
    projectRoot: setup.root,
    workflowId: definition.workflowId,
    source: definition.snapshotSource,
  });
  const run: RunRecord = {
    id: runId,
    workflowId: definition.workflowId,
    workflowPath: definition.workflowPath,
    projectRoot: setup.root,
    workspace: { mode: "worktree", worktrees: [] },
    definitionSnapshot: snapshot.record,
    status: "running",
    controllerStatus: "detached",
    createdAt: "2026-08-11T12:00:00.000Z",
    deadlineAt: "2026-08-11T12:05:00.000Z",
    transitionCount: 0,
    visits: [],
    documents: [],
    events: [],
  };
  await repository.save(run);
  return { definition, repository, run };
}

async function writeResult(launch: TaskLaunch, outcome: string): Promise<void> {
  await writeFile(
    launch.resultPath,
    `${JSON.stringify({ outcome, documents: [] })}\n`,
  );
}

class RecoveryExecutor implements TaskExecutor {
  readonly launches: TaskLaunch[] = [];
  readonly recoveries: Array<{ identity: string; projectWorkspace: string }> =
    [];

  constructor(
    private readonly onLaunch: (launch: TaskLaunch) => Promise<void>,
  ) {}

  recover(
    identity: string,
    _references: ExecutorReferences | undefined,
    projectWorkspace: string,
  ): Promise<RecoveryObservation> {
    this.recoveries.push({ identity, projectWorkspace });
    return Promise.resolve({ status: "not_found" });
  }

  async execute(
    launch: TaskLaunch,
    onStarted: Parameters<TaskExecutor["execute"]>[1],
  ): Promise<TaskExecution> {
    this.launches.push(structuredClone(launch));
    const references = {
      taskId: `task-${this.launches.length}`,
      dispatchId: `dispatch-${this.launches.length}`,
    };
    await onStarted(references);
    await this.onLaunch(launch);
    return { references, logs: { stdout: "recovered", stderr: "" } };
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  reconcile(): Promise<"stopped"> {
    return Promise.resolve("stopped");
  }
}

const normalWorkflow = `version: 1
id: recover-main
initial_state: work
states:
  work:
    type: agent
    agent: worker
    prompt: work
    outcomes:
      done: $succeeded
`;

const parallelWorkflow = `version: 1
id: recover-parallel
initial_state: fan_out
states:
  fan_out:
    type: parallel
    tasks:
      alpha:
        agent: worker
        prompt: alpha
      beta:
        agent: worker
        prompt: beta
      gamma:
        agent: worker
        prompt: gamma
    outcomes:
      succeeded: $succeeded
      failed: $failed
`;

describe("worktree recovery and cancellation", () => {
  it("adopts a main worktree created before its durable metadata save", async () => {
    const setup = await project(normalWorkflow);
    const durable = await detachedRun(setup, "run_recover_main");
    const gitWorkspaces = new GitProjectWorkspaces();
    const orphan = await gitWorkspaces.ensureMain({
      projectRoot: setup.root,
      runId: durable.run.id,
    });
    const executor = new RecoveryExecutor((launch) =>
      writeResult(launch, "done"),
    );

    const run = await new RecoverWorkflow(
      durable.repository,
      executor,
      () => new Date("2026-08-11T12:00:01.000Z"),
      () => Promise.resolve(),
      new ProjectWorkspaceCoordinator(gitWorkspaces),
    ).recover({
      projectRoot: setup.root,
      runId: durable.run.id,
      controllerId: "recovery-controller",
    });

    expect(run.status).toBe("succeeded");
    expect(run.workspace?.worktrees).toMatchObject([
      { id: "main", path: orphan.path, branch: orphan.branch },
    ]);
    expect(executor.launches.map((launch) => launch.projectWorkspace)).toEqual([
      orphan.path,
    ]);
    expect(executor.recoveries.map((item) => item.projectWorkspace)).toEqual([
      orphan.path,
    ]);
    expect(
      (await git(setup.root, "worktree", "list", "--porcelain"))
        .split("\n")
        .filter((line) => line.startsWith("worktree ")),
    ).toHaveLength(2);
  });

  it("recovers every child from the persisted fan-out HEAD after the main advances", async () => {
    const setup = await project(parallelWorkflow);
    const durable = await detachedRun(setup, "run_recover_children");
    const gitWorkspaces = new GitProjectWorkspaces();
    const main = await gitWorkspaces.ensureMain({
      projectRoot: setup.root,
      runId: durable.run.id,
    });
    recordWorktree(durable.run, main);
    await writeFile(path.join(main.path, "captured.txt"), "captured base\n");
    await git(main.path, "add", "captured.txt");
    await git(main.path, "commit", "--quiet", "-m", "captured base");
    const fanOutHead = await git(main.path, "rev-parse", "HEAD");
    recordWorktreeObservation(durable.run, main.id, fanOutHead, false);
    const visit: ParallelVisitRecord = {
      type: "parallel",
      stateId: "fan_out",
      number: 1,
      contextPath: "",
      fanOutHead,
      tasks: ["alpha", "beta", "gamma"].map((id) => ({
        id,
        status: "queued",
        attempts: [],
        documents: [],
        workspace: { mode: "worktree", path: "" },
      })),
    };
    durable.run.visits.push(visit);
    const orphanAlpha = await gitWorkspaces.ensureChild({
      projectRoot: setup.root,
      runId: durable.run.id,
      stateId: visit.stateId,
      visitNumber: visit.number,
      taskId: "alpha",
      startingHead: fanOutHead,
    });
    await durable.repository.save(durable.run);
    await writeFile(path.join(main.path, "newer.txt"), "must not fan out\n");
    await git(main.path, "add", "newer.txt");
    await git(main.path, "commit", "--quiet", "-m", "newer main");
    const newerMainHead = await git(main.path, "rev-parse", "HEAD");
    const executor = new RecoveryExecutor(async (launch) => {
      expect(
        await readFile(
          path.join(launch.projectWorkspace, "captured.txt"),
          "utf8",
        ),
      ).toBe("captured base\n");
      await expect(
        readFile(path.join(launch.projectWorkspace, "newer.txt"), "utf8"),
      ).rejects.toThrow();
      await writeResult(launch, "succeeded");
    });

    const run = await new RecoverWorkflow(
      durable.repository,
      executor,
      () => new Date("2026-08-11T12:00:01.000Z"),
      () => Promise.resolve(),
      new ProjectWorkspaceCoordinator(gitWorkspaces),
    ).recover({
      projectRoot: setup.root,
      runId: durable.run.id,
      controllerId: "child-recovery-controller",
    });

    expect(run.status).toBe("succeeded");
    const recoveredVisit = run.visits[0];
    if (recoveredVisit.type !== "parallel")
      throw new Error("expected parallel visit");
    expect(recoveredVisit.fanOutHead).toBe(fanOutHead);
    expect(
      recoveredVisit.tasks.map((task) => task.workspace.startingHead),
    ).toEqual([fanOutHead, fanOutHead, fanOutHead]);
    expect(recoveredVisit.tasks[0].workspace.path).toBe(orphanAlpha.path);
    expect(await git(main.path, "rev-parse", "HEAD")).toBe(newerMainHead);
    const context = await readFile(recoveredVisit.contextPath, "utf8");
    expect(context).toContain("parallel:fan_out:1:alpha");
    expect(context).toContain("parallel:fan_out:1:beta");
    expect(context).toContain("parallel:fan_out:1:gamma");
  });

  it("cancels and reconciles an active task in its child worktree and retains it", async () => {
    const setup = await project(`version: 1
id: cancel-child
initial_state: fan_out
states:
  fan_out:
    type: parallel
    tasks:
      alpha:
        agent: worker
        prompt: alpha
    outcomes:
      succeeded: $succeeded
      failed: $failed
`);
    const durable = await detachedRun(setup, "run_cancel_child");
    const gitWorkspaces = new GitProjectWorkspaces();
    const main = await gitWorkspaces.ensureMain({
      projectRoot: setup.root,
      runId: durable.run.id,
    });
    recordWorktree(durable.run, main);
    const child = await gitWorkspaces.ensureChild({
      projectRoot: setup.root,
      runId: durable.run.id,
      stateId: "fan_out",
      visitNumber: 1,
      taskId: "alpha",
      startingHead: main.startingHead,
    });
    recordWorktree(durable.run, child);
    const references = {
      taskId: "orca-task",
      dispatchId: "orca-dispatch",
      terminalHandle: "orca-terminal",
    };
    const attempt: AttemptRecord = {
      id: `${durable.run.id}:fan_out:1:alpha:1`,
      number: 1,
      status: "running",
      controlWorkspace: path.join(setup.root, "control"),
      contextPath: path.join(setup.root, "context.md"),
      outputDirectory: path.join(setup.root, "output"),
      resultPath: path.join(setup.root, "output", "result.json"),
      executor: references,
      logs: { stdout: "", stderr: "" },
      documents: [],
    };
    durable.run.visits.push({
      type: "parallel",
      stateId: "fan_out",
      number: 1,
      contextPath: attempt.contextPath,
      fanOutHead: main.startingHead,
      tasks: [
        {
          id: "alpha",
          status: "running",
          attempts: [attempt],
          documents: [],
          workspace: taskWorkspaceFromWorktree(child),
        },
      ],
    });
    await durable.repository.save(durable.run);
    await writeFile(path.join(child.path, "unfinished.txt"), "retain me\n");
    const calls: Array<{ operation: string; workspace: string }> = [];
    const executor: TaskExecutor = {
      recover: (
        _identity: string,
        _known: ExecutorReferences | undefined,
        projectWorkspace: string,
      ) => {
        calls.push({ operation: "recover", workspace: projectWorkspace });
        return Promise.resolve({
          status: "active",
          references,
          logs: { stdout: "active", stderr: "" },
        });
      },
      execute: () => Promise.reject(new Error("must not launch")),
      cancel: (_external, projectWorkspace) => {
        calls.push({ operation: "cancel", workspace: projectWorkspace });
        return Promise.resolve();
      },
      reconcile: (_external, projectWorkspace) => {
        calls.push({ operation: "reconcile", workspace: projectWorkspace });
        return Promise.resolve("stopped");
      },
    };

    const run = await new CancelWorkflow(
      durable.repository,
      executor,
      () => new Date("2026-08-11T12:00:02.000Z"),
      () => Promise.resolve(),
      new ProjectWorkspaceCoordinator(gitWorkspaces),
    ).cancel({
      currentDirectory: setup.root,
      runId: durable.run.id,
      controllerId: "cancellation-controller",
    });

    expect(run.status).toBe("canceled");
    expect(calls).toEqual([
      { operation: "recover", workspace: child.path },
      { operation: "cancel", workspace: child.path },
      { operation: "reconcile", workspace: child.path },
    ]);
    expect(
      run.workspace?.worktrees.find((worktree) => worktree.id === child.id),
    ).toMatchObject({ dirty: true, endingHead: child.startingHead });
    await expect(stat(main.path)).resolves.toMatchObject({});
    await expect(stat(child.path)).resolves.toMatchObject({});
    expect(
      await readFile(path.join(child.path, "unfinished.txt"), "utf8"),
    ).toBe("retain me\n");
  });
});
