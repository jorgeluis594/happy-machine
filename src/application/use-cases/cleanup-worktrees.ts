import type {
  RunRecord,
  WorktreeCleanupEvaluation,
} from "../../domain/execution/run.js";
import { runIsTerminal, workspaceMode } from "../../domain/execution/run.js";
import type { ProjectWorkspaces } from "../../ports/project-workspaces.js";
import type { RunRepository } from "../../ports/run-repository.js";

export interface CleanupResult {
  run: RunRecord;
  evaluations: WorktreeCleanupEvaluation[];
}

export class CleanupWorktrees {
  constructor(
    private readonly runs: RunRepository,
    private readonly workspaces: ProjectWorkspaces,
    private readonly now: () => Date,
  ) {}

  async claimPrompt(
    currentDirectory: string,
    runId: string,
  ): Promise<RunRecord | undefined> {
    if (!this.runs.discoverProjectRoot || !this.runs.claimCleanupPrompt)
      throw new Error("Run repository does not support cleanup prompting");
    const projectRoot = await this.runs.discoverProjectRoot(currentDirectory);
    return this.runs.claimCleanupPrompt(
      projectRoot,
      runId,
      this.now().toISOString(),
    );
  }

  async retain(run: RunRecord): Promise<RunRecord> {
    const at = this.now().toISOString();
    run.cleanup ??= { evaluations: [] };
    run.cleanup.decision = "retain";
    run.cleanup.decidedAt = at;
    this.event(run, "worktree_cleanup_decided", at, { decision: "retain" });
    await this.runs.save(run);
    return run;
  }

  async cleanup(
    currentDirectory: string,
    runId: string,
    promptedRun?: RunRecord,
  ): Promise<CleanupResult> {
    const run = promptedRun ?? (await this.load(currentDirectory, runId));
    if (!runIsTerminal(run.status))
      throw new Error(
        `Run ${run.id} is ${run.status}; cleanup requires a terminal run`,
      );
    const decidedAt = this.now().toISOString();
    run.cleanup ??= { evaluations: [] };
    run.cleanup.decision = "cleanup";
    run.cleanup.decidedAt = decidedAt;
    this.event(run, "worktree_cleanup_decided", decidedAt, {
      decision: "cleanup",
    });
    await this.runs.save(run);

    const evaluations: WorktreeCleanupEvaluation[] = [];
    if (workspaceMode(run) === "worktree") {
      const removed = new Set(
        run.cleanup.evaluations
          .filter((evaluation) => evaluation.result === "removed")
          .map((evaluation) => evaluation.worktreeId),
      );
      for (const worktree of run.workspace?.worktrees ?? []) {
        if (removed.has(worktree.id)) continue;
        const evaluatedAt = this.now().toISOString();
        let evaluation: WorktreeCleanupEvaluation;
        try {
          const removal = await this.workspaces.remove({
            projectRoot: run.projectRoot,
            runId: run.id,
            worktree,
          });
          worktree.endingHead = removal.observation.endingHead;
          worktree.dirty = removal.observation.dirty;
          evaluation = {
            worktreeId: worktree.id,
            path: worktree.path,
            dirty: removal.observation.dirty,
            result: removal.result,
            evaluatedAt,
            ...(removal.result === "retained_dirty"
              ? { message: "Uncommitted changes require manual attention" }
              : {}),
          };
        } catch (error) {
          evaluation = {
            worktreeId: worktree.id,
            path: worktree.path,
            dirty: worktree.dirty,
            result: "failed",
            evaluatedAt,
            message: error instanceof Error ? error.message : String(error),
          };
        }
        evaluations.push(evaluation);
        run.cleanup.evaluations.push(evaluation);
        this.event(run, "worktree_cleanup_evaluated", evaluatedAt, {
          ...evaluation,
        });
        await this.runs.save(run);
      }
    }
    return { run, evaluations };
  }

  private async load(
    currentDirectory: string,
    runId: string,
  ): Promise<RunRecord> {
    if (!this.runs.discoverProjectRoot || !this.runs.load)
      throw new Error("Run repository does not support cleanup");
    const projectRoot = await this.runs.discoverProjectRoot(currentDirectory);
    return (await this.runs.load(projectRoot, runId)).run;
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
