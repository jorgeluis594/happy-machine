import type {
  AttemptFailure,
  ManagedWorktreeRecord,
  ParallelVisitRecord,
  RunRecord,
  TaskRecord,
  VisitRecord,
} from "../../domain/execution/run.js";
import {
  mainWorktree,
  parallelTaskWorktree,
  recordWorktree,
  recordWorktreeObservation,
  taskWorkspaceFromWorktree,
  workspaceMode,
} from "../../domain/execution/run.js";
import type { ProjectWorkspaces } from "../../ports/project-workspaces.js";
import { ProjectWorkspaceError } from "../../ports/project-workspaces.js";

export type WorkspaceTimestamp = () => string;
export type PersistWorkspaceState = () => Promise<void>;

export class ProjectWorkspaceCoordinator {
  constructor(private readonly workspaces: ProjectWorkspaces) {}

  async prepareMain(
    run: RunRecord,
    timestamp: WorkspaceTimestamp,
    persist: PersistWorkspaceState,
  ): Promise<void> {
    if (workspaceMode(run) === "direct" || mainWorktree(run)) return;
    const worktree = await this.workspaces.ensureMain({
      projectRoot: run.projectRoot,
      runId: run.id,
    });
    recordWorktree(run, worktree);
    this.event(run, "worktree_created", timestamp(), this.eventData(worktree));
    await persist();
  }

  async prepareParallel(
    run: RunRecord,
    visit: ParallelVisitRecord,
    timestamp: WorkspaceTimestamp,
    persist: PersistWorkspaceState,
  ): Promise<void> {
    if (workspaceMode(run) === "direct") return;
    const main = mainWorktree(run);
    if (!main) throw new Error(`Run ${run.id} has no prepared main worktree`);
    if (!visit.fanOutHead) {
      const observation = await this.workspaces.observe(main);
      const observed = recordWorktreeObservation(
        run,
        main.id,
        observation.endingHead,
        observation.dirty,
      );
      visit.fanOutHead = observation.endingHead;
      this.event(run, "worktree_observed", timestamp(), {
        ...this.eventData(observed),
        phase: "parallel_fan_out",
      });
      this.event(run, "parallel_fan_out_head_captured", timestamp(), {
        stateId: visit.stateId,
        visitNumber: visit.number,
        head: visit.fanOutHead,
      });
      await persist();
    }
    for (const task of visit.tasks) {
      if (task.execution?.type === "workflow") continue;
      let worktree = parallelTaskWorktree(
        run,
        visit.stateId,
        visit.number,
        task.id,
      );
      if (!worktree) {
        worktree = await this.workspaces.ensureChild({
          projectRoot: run.projectRoot,
          runId: run.id,
          stateId: visit.stateId,
          visitNumber: visit.number,
          taskId: task.id,
          startingHead: visit.fanOutHead,
        });
        recordWorktree(run, worktree);
        this.event(
          run,
          "worktree_created",
          timestamp(),
          this.eventData(worktree),
        );
      }
      task.workspace = taskWorkspaceFromWorktree(worktree);
      await persist();
    }
  }

  async observeTask(
    run: RunRecord,
    visit: VisitRecord,
    task: TaskRecord,
    timestamp: WorkspaceTimestamp,
    phase = "task_settled",
  ): Promise<void> {
    if (workspaceMode(run) === "direct") return;
    const worktree =
      visit.type === "agent"
        ? mainWorktree(run)
        : parallelTaskWorktree(run, visit.stateId, visit.number, task.id);
    if (!worktree)
      throw new Error(`Task ${task.id} has no managed project worktree`);
    await this.observe(run, worktree, timestamp, phase);
  }

  async observeAll(
    run: RunRecord,
    timestamp: WorkspaceTimestamp,
    phase = "run_terminal",
  ): Promise<void> {
    if (workspaceMode(run) === "direct") return;
    for (const worktree of run.workspace?.worktrees ?? [])
      await this.observe(run, worktree, timestamp, phase);
  }

  private async observe(
    run: RunRecord,
    worktree: ManagedWorktreeRecord,
    timestamp: WorkspaceTimestamp,
    phase: string,
  ): Promise<void> {
    const observation = await this.workspaces.observe(worktree);
    const observed = recordWorktreeObservation(
      run,
      worktree.id,
      observation.endingHead,
      observation.dirty,
    );
    this.event(run, "worktree_observed", timestamp(), {
      ...this.eventData(observed),
      phase,
    });
  }

  private eventData(worktree: ManagedWorktreeRecord): Record<string, unknown> {
    return {
      worktreeId: worktree.id,
      role: worktree.role,
      ...(worktree.provenance ?? {}),
      path: worktree.path,
      branch: worktree.branch,
      startingHead: worktree.startingHead,
      endingHead: worktree.endingHead,
      dirty: worktree.dirty,
    };
  }

  private event(
    run: RunRecord,
    type: string,
    at: string,
    data: Record<string, unknown>,
  ): void {
    run.events.push({ sequence: run.events.length + 1, type, at, data });
  }
}

export function workspaceFailure(error: unknown): AttemptFailure {
  return {
    code: "workspace_preparation_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function requireWorkspaceCoordinator(
  coordinator: ProjectWorkspaceCoordinator | undefined,
): ProjectWorkspaceCoordinator {
  if (!coordinator)
    throw new ProjectWorkspaceError(
      "Project worktree support is not configured",
    );
  return coordinator;
}
