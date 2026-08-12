import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ExecuteWorkflow,
  type Wait,
} from "../src/application/use-cases/execute-workflow.js";
import { ProjectWorkspaceCoordinator } from "../src/application/services/project-workspace-coordinator.js";
import { InspectRuns } from "../src/application/use-cases/inspect-runs.js";
import type { RunRecord } from "../src/domain/execution/run.js";
import { RunPresenter } from "../src/infrastructure/inbound/cli/run-presenter.js";
import { FilesystemProjectDefinitions } from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";
import { GitProjectWorkspaces } from "../src/infrastructure/outbound/project-workspaces/git/git-project-workspaces.js";
import { FilesystemRunRepository } from "../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";
import type { ProjectWorkspaces } from "../src/ports/project-workspaces.js";
import { ProjectWorkspaceError } from "../src/ports/project-workspaces.js";
import type {
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
  initialHead: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-isolation-"));
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
    model: test-model
defaults:
  attempt_timeout: 5s
  max_attempts: 1
  retry_delay: 1ms
  workflow_timeout: 5m
  max_concurrency: 3
`,
  );
  await writeFile(
    path.join(root, "agents", "worker.md"),
    "# Worker\nModify only the assigned project workspace.\n",
  );
  const workflowPath = path.join(root, "workflows", "workflow.yaml");
  await writeFile(workflowPath, workflow);
  await writeFile(path.join(root, "tracked.txt"), "committed original\n");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "initial project");
  return {
    root,
    workflowPath,
    initialHead: await git(root, "rev-parse", "HEAD"),
  };
}

async function writeResult(launch: TaskLaunch, outcome: string): Promise<void> {
  await writeFile(
    launch.resultPath,
    `${JSON.stringify({ outcome, documents: [] })}\n`,
  );
}

class BehaviorExecutor implements TaskExecutor {
  readonly launches: TaskLaunch[] = [];

  constructor(
    private readonly behavior: (launch: TaskLaunch) => Promise<void>,
  ) {}

  async execute(
    launch: TaskLaunch,
    onStarted: Parameters<TaskExecutor["execute"]>[1],
  ): Promise<TaskExecution> {
    this.launches.push(structuredClone(launch));
    const number = this.launches.length;
    const references = {
      taskId: `task-${number}`,
      dispatchId: `dispatch-${number}`,
      terminalHandle: `terminal-${number}`,
    };
    await onStarted(references);
    await this.behavior(launch);
    return { references, logs: { stdout: "completed", stderr: "" } };
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  reconcile(): Promise<"stopped"> {
    return Promise.resolve("stopped");
  }
}

const wait: Wait = (_milliseconds, signal) =>
  signal ? new Promise(() => {}) : Promise.resolve();

async function execute(
  setup: { root: string; workflowPath: string },
  executor: TaskExecutor,
  options: {
    repository?: FilesystemRunRepository;
    workspaces?: ProjectWorkspaces;
    allocated?: string[];
  } = {},
): Promise<RunRecord> {
  const repository = options.repository ?? new FilesystemRunRepository();
  return new ExecuteWorkflow(
    new FilesystemProjectDefinitions(),
    repository,
    executor,
    () => new Date("2026-08-11T12:00:00.000Z"),
    () => "isolation",
    wait,
    new ProjectWorkspaceCoordinator(
      options.workspaces ?? new GitProjectWorkspaces(),
    ),
  ).execute({
    workflowPath: setup.workflowPath,
    currentDirectory: setup.root,
    onRunAllocated: (runId) => options.allocated?.push(runId),
  });
}

const sequentialWorkflow = `version: 1
id: sequential-isolation
initial_state: first
states:
  first:
    type: agent
    agent: worker
    prompt: first
    outcomes:
      next: second
  second:
    type: agent
    agent: worker
    prompt: second
    outcomes:
      done: $succeeded
`;

describe("workflow Git worktree isolation", () => {
  it("starts the main worktree from HEAD and shares it across sequential states", async () => {
    const setup = await project(sequentialWorkflow);
    await writeFile(path.join(setup.root, "tracked.txt"), "dirty original\n");
    await writeFile(path.join(setup.root, "original-only.txt"), "local only\n");
    let firstWorkspace = "";
    const executor = new BehaviorExecutor(async (launch) => {
      if (launch.prompt === "first") {
        firstWorkspace = launch.projectWorkspace;
        await writeFile(
          path.join(launch.projectWorkspace, "sequential.txt"),
          "from first state\n",
        );
        await writeResult(launch, "next");
        return;
      }
      expect(launch.projectWorkspace).toBe(firstWorkspace);
      expect(
        await readFile(
          path.join(launch.projectWorkspace, "sequential.txt"),
          "utf8",
        ),
      ).toBe("from first state\n");
      await writeResult(launch, "done");
    });

    const run = await execute(setup, executor);

    expect(run.status).toBe("succeeded");
    expect(executor.launches).toHaveLength(2);
    expect(firstWorkspace).not.toBe(setup.root);
    expect(run.workspace).toMatchObject({
      mode: "worktree",
      worktrees: [
        {
          id: "main",
          role: "main",
          startingHead: setup.initialHead,
          endingHead: setup.initialHead,
          dirty: true,
        },
      ],
    });
    await expect(
      readFile(path.join(setup.root, "sequential.txt"), "utf8"),
    ).rejects.toThrow();
    expect(await readFile(path.join(setup.root, "tracked.txt"), "utf8")).toBe(
      "dirty original\n",
    );
    expect(
      await readFile(path.join(setup.root, "original-only.txt"), "utf8"),
    ).toBe("local only\n");
    expect(
      new Set(
        run.visits.flatMap((visit) =>
          visit.type === "agent"
            ? visit.task.attempts.map((attempt) => attempt.controlWorkspace)
            : [],
        ),
      ),
    ).toHaveLength(2);
    const secondContext = await readFile(run.visits[1].contextPath, "utf8");
    expect(secondContext).toContain("## Project workspace");
    expect(secondContext).toContain(firstWorkspace);
    expect(secondContext).toContain("Dirty: true");
  });

  it("fans out from one committed main HEAD, isolates dirty files and child changes, and exposes complete metadata", async () => {
    const setup = await project(`version: 1
id: parallel-isolation
initial_state: prepare
states:
  prepare:
    type: agent
    agent: worker
    prompt: prepare
    outcomes:
      ready: fan_out
  fan_out:
    type: parallel
    max_concurrency: 3
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
      succeeded: integrate
      failed: $failed
  integrate:
    type: agent
    agent: worker
    prompt: integrate
    outcomes:
      done: $succeeded
`);
    let fanOutHead = "";
    let mainPath = "";
    let mutationQueue = Promise.resolve();
    const childHeads = new Map<string, string>();
    const executor = new BehaviorExecutor(async (launch) => {
      if (launch.prompt === "prepare") {
        mainPath = launch.projectWorkspace;
        await writeFile(
          path.join(mainPath, "committed-main.txt"),
          "visible to children\n",
        );
        await git(mainPath, "add", "committed-main.txt");
        await git(mainPath, "commit", "--quiet", "-m", "agent handoff");
        fanOutHead = await git(mainPath, "rev-parse", "HEAD");
        await writeFile(path.join(mainPath, "tracked.txt"), "dirty main\n");
        await writeFile(
          path.join(mainPath, "main-only.txt"),
          "not committed\n",
        );
        await writeResult(launch, "ready");
        return;
      }
      if (["alpha", "beta", "gamma"].includes(launch.prompt)) {
        expect(launch.projectWorkspace).not.toBe(mainPath);
        const initialContext = await readFile(launch.contextPath, "utf8");
        for (const taskId of ["alpha", "beta", "gamma"])
          expect(initialContext).toContain(`parallel:fan_out:1:${taskId}`);
        expect(
          await readFile(
            path.join(launch.projectWorkspace, "committed-main.txt"),
            "utf8",
          ),
        ).toBe("visible to children\n");
        expect(
          await readFile(
            path.join(launch.projectWorkspace, "tracked.txt"),
            "utf8",
          ),
        ).toBe("committed original\n");
        await expect(
          readFile(path.join(launch.projectWorkspace, "main-only.txt"), "utf8"),
        ).rejects.toThrow();
        const mutation = mutationQueue.then(async () => {
          await writeFile(
            path.join(launch.projectWorkspace, "conflict.txt"),
            `${launch.prompt}\n`,
          );
          await git(launch.projectWorkspace, "add", "conflict.txt");
          await git(
            launch.projectWorkspace,
            "commit",
            "--quiet",
            "-m",
            `${launch.prompt} change`,
          );
          childHeads.set(
            launch.prompt,
            await git(launch.projectWorkspace, "rev-parse", "HEAD"),
          );
          await writeFile(
            path.join(launch.projectWorkspace, `${launch.prompt}-dirty.txt`),
            "uncommitted\n",
          );
        });
        mutationQueue = mutation.then(
          () => undefined,
          () => undefined,
        );
        await mutation;
        await writeResult(launch, "succeeded");
        return;
      }
      expect(launch.prompt).toBe("integrate");
      expect(launch.projectWorkspace).toBe(mainPath);
      expect(await git(mainPath, "rev-parse", "HEAD")).toBe(fanOutHead);
      await expect(
        readFile(path.join(mainPath, "conflict.txt"), "utf8"),
      ).rejects.toThrow();
      const context = await readFile(launch.contextPath, "utf8");
      expect(context).toContain("## Project workspace");
      for (const taskId of ["alpha", "beta", "gamma"]) {
        expect(context).toContain(`parallel:fan_out:1:${taskId}`);
        expect(context).toContain(childHeads.get(taskId)!);
      }
      await writeResult(launch, "done");
    });
    const repository = new FilesystemRunRepository();

    const run = await execute(setup, executor, { repository });

    expect(run.status).toBe("succeeded");
    expect(run.visits).toHaveLength(3);
    const parallel = run.visits[1];
    if (parallel.type !== "parallel")
      throw new Error("expected parallel visit");
    expect(parallel.fanOutHead).toBe(fanOutHead);
    expect(
      new Set(parallel.tasks.map((task) => task.workspace.path)),
    ).toHaveLength(3);
    expect(parallel.tasks.map((task) => task.workspace.startingHead)).toEqual([
      fanOutHead,
      fanOutHead,
      fanOutHead,
    ]);
    expect(
      new Set(parallel.tasks.map((task) => task.workspace.endingHead)),
    ).toEqual(new Set(childHeads.values()));
    expect(parallel.tasks.every((task) => task.workspace.dirty)).toBe(true);
    expect(await git(mainPath, "rev-parse", "HEAD")).toBe(fanOutHead);
    await expect(
      readFile(path.join(mainPath, "conflict.txt"), "utf8"),
    ).rejects.toThrow();
    for (const worktree of run.workspace?.worktrees ?? [])
      await expect(stat(worktree.path)).resolves.toMatchObject({});

    const status = new RunPresenter().status(
      await new InspectRuns(
        repository,
        () => new Date("2026-08-11T12:00:01.000Z"),
      ).status(setup.root, run.id),
    );
    expect(status).toContain("Managed worktrees:");
    expect(status).toContain("parallel:fan_out:1:alpha");
    expect(status).toContain(`starting_head=${fanOutHead}`);
    expect(status).toContain(`ending_head=${childHeads.get("alpha")!}`);
    expect(status).toContain("dirty=true");
    const history = new RunPresenter().history(
      await new InspectRuns(
        repository,
        () => new Date("2026-08-11T12:00:01.000Z"),
      ).history(setup.root, run.id),
    );
    expect(history).toContain("worktree_created");
    expect(history).toContain("worktree_observed");
    expect(history).toContain(childHeads.get("alpha")!);
  });

  it("durably fails after allocation when main-worktree preparation fails and launches no state", async () => {
    const setup = await project(sequentialWorkflow);
    const allocated: string[] = [];
    const repository = new FilesystemRunRepository();
    const executor = new BehaviorExecutor(() =>
      Promise.reject(new Error("must not launch")),
    );
    const failing: ProjectWorkspaces = {
      ensureMain: () =>
        Promise.reject(new ProjectWorkspaceError("injected Git failure")),
      ensureChild: () => Promise.reject(new Error("must not create child")),
      observe: () => Promise.reject(new Error("must not observe")),
      remove: () => Promise.reject(new Error("must not remove")),
    };

    const run = await execute(setup, executor, {
      repository,
      workspaces: failing,
      allocated,
    });

    expect(allocated).toEqual(["run_isolation"]);
    expect(run).toMatchObject({
      status: "failed",
      failure: {
        code: "workspace_preparation_failed",
        message: "injected Git failure",
      },
      visits: [],
    });
    expect(executor.launches).toHaveLength(0);
    const durable = await repository.load(setup.root, run.id);
    expect(durable.run).toMatchObject({
      status: "failed",
      failure: { code: "workspace_preparation_failed" },
      visits: [],
    });
    expect(durable.run.events.map((event) => event.type)).toContain(
      "workspace_preparation_failed",
    );
  });

  it("durably retains partial fan-out preparation and launches no child when a required child fails", async () => {
    const setup = await project(`version: 1
id: partial-fan-out
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
`);
    const gitWorkspaces = new GitProjectWorkspaces();
    let children = 0;
    const partialFailure: ProjectWorkspaces = {
      ensureMain: (request) => gitWorkspaces.ensureMain(request),
      ensureChild: (request) => {
        children += 1;
        return children === 2
          ? Promise.reject(
              new ProjectWorkspaceError("injected child creation failure"),
            )
          : gitWorkspaces.ensureChild(request);
      },
      observe: (worktree) => gitWorkspaces.observe(worktree),
      remove: (request) => gitWorkspaces.remove(request),
    };
    const executor = new BehaviorExecutor(() =>
      Promise.reject(new Error("must not launch")),
    );

    const run = await execute(setup, executor, {
      workspaces: partialFailure,
    });

    expect(run).toMatchObject({
      status: "failed",
      failure: {
        code: "workspace_preparation_failed",
        message: "injected child creation failure",
      },
    });
    expect(executor.launches).toHaveLength(0);
    expect(run.workspace?.worktrees.map((worktree) => worktree.id)).toEqual([
      "main",
      "parallel:fan_out:1:alpha",
    ]);
    for (const worktree of run.workspace?.worktrees ?? [])
      await expect(stat(worktree.path)).resolves.toMatchObject({});
    expect(
      run.visits[0].type === "parallel"
        ? run.visits[0].tasks.every((task) => task.attempts.length === 0)
        : false,
    ).toBe(true);
  });

  it("retains the main worktree after a workflow reaches the failed terminal", async () => {
    const setup = await project(`version: 1
id: retained-failure
initial_state: reject
states:
  reject:
    type: agent
    agent: worker
    prompt: reject
    outcomes:
      rejected: $failed
`);
    const run = await execute(
      setup,
      new BehaviorExecutor((launch) => writeResult(launch, "rejected")),
    );

    expect(run.status).toBe("failed");
    expect(run.workspace?.worktrees).toHaveLength(1);
    await expect(stat(run.workspace!.worktrees[0].path)).resolves.toMatchObject(
      {},
    );
  });
});
