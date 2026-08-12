import type { ExecuteWorkflow } from "../../../application/use-cases/execute-workflow.js";
import type { CancelWorkflow } from "../../../application/use-cases/cancel-workflow.js";
import type { RecoverWorkflow } from "../../../application/use-cases/recover-workflow.js";
import { ControllerDetachedError } from "../../../application/services/controller-detachment.js";
import type { InspectRuns } from "../../../application/use-cases/inspect-runs.js";
import type { CleanupWorktrees } from "../../../application/use-cases/cleanup-worktrees.js";
import type { RunRecord } from "../../../domain/execution/run.js";
import { runIsTerminal } from "../../../domain/execution/run.js";
import { RunPresenter } from "./run-presenter.js";

export interface CliStreams {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CleanupPrompt {
  isInteractive(): boolean;
  confirm(message: string): Promise<boolean>;
}

export class Cli {
  constructor(
    private readonly executeWorkflow: ExecuteWorkflow,
    private readonly recoverWorkflow: RecoverWorkflow,
    private readonly cancelWorkflow: CancelWorkflow,
    private readonly inspectRuns: InspectRuns,
    private readonly streams: CliStreams,
    private readonly presenter = new RunPresenter(),
    private readonly cleanupWorktrees?: CleanupWorktrees,
    private readonly cleanupPrompt?: CleanupPrompt,
  ) {}

  async run(
    argv: string[],
    currentDirectory: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const request = this.request(argv);
    if (!request) {
      this.streams.stderr(
        "Usage: happy-machine execute WORKFLOW_PATH [--input DOCUMENT.md ...] | happy-machine resume RUN_ID | happy-machine cancel RUN_ID | happy-machine cleanup RUN_ID | happy-machine status RUN_ID | happy-machine history [RUN_ID]",
      );
      return 1;
    }
    try {
      if (request.command === "status") {
        this.streams.stdout(
          this.presenter.status(
            await this.inspectRuns.status(currentDirectory, request.runId),
          ),
        );
        return 0;
      }
      if (request.command === "history") {
        this.streams.stdout(
          this.presenter.history(
            await this.inspectRuns.history(currentDirectory, request.runId),
          ),
        );
        return 0;
      }
      if (request.command === "cleanup") {
        const result = await this.requireCleanup().cleanup(
          currentDirectory,
          request.runId,
        );
        this.presentCleanup(result.run, result.evaluations);
        return result.evaluations.some((item) => item.result === "failed")
          ? 1
          : 0;
      }
      const run =
        request.command === "execute"
          ? await this.executeWorkflow.execute({
              workflowPath: request.workflowPath,
              currentDirectory,
              inputPaths: request.inputPaths,
              onRunAllocated: (id) => this.streams.stdout(id),
              signal,
            })
          : request.command === "resume"
            ? await this.recoverWorkflow.recover({
                projectRoot: currentDirectory,
                runId: request.runId,
                controllerId: `${request.runId}:resume:${process.pid}`,
                signal,
              })
            : await this.cancelWorkflow.cancel({
                currentDirectory,
                runId: request.runId,
                controllerId: `${request.runId}:cancel:${process.pid}`,
                signal,
              });
      this.streams.stdout(`Run ${run.id}: ${run.status}`);
      await this.maybePromptForCleanup(currentDirectory, run);
      return run.status === "succeeded" ? 0 : run.status === "canceled" ? 2 : 1;
    } catch (error) {
      if (error instanceof ControllerDetachedError) return 130;
      this.streams.stderr(
        error instanceof Error ? error.message : String(error),
      );
      return 1;
    }
  }

  private request(
    argv: string[],
  ):
    | { command: "execute"; workflowPath: string; inputPaths: string[] }
    | { command: "resume"; runId: string }
    | { command: "cancel"; runId: string }
    | { command: "cleanup"; runId: string }
    | { command: "status"; runId: string }
    | { command: "history"; runId?: string }
    | undefined {
    if (argv[0] === "resume" && argv.length === 2 && argv[1])
      return { command: "resume", runId: argv[1] };
    if (argv[0] === "cancel" && argv.length === 2 && argv[1])
      return { command: "cancel", runId: argv[1] };
    if (argv[0] === "cleanup" && argv.length === 2 && argv[1])
      return { command: "cleanup", runId: argv[1] };
    if (argv[0] === "status" && argv.length === 2 && argv[1])
      return { command: "status", runId: argv[1] };
    if (argv[0] === "history" && argv.length <= 2)
      return { command: "history", runId: argv[1] };
    if (argv[0] !== "execute" || argv.length < 2) return undefined;
    const workflowPath = argv[1];
    if (!workflowPath || workflowPath.startsWith("--")) return undefined;
    const inputPaths: string[] = [];
    for (let index = 2; index < argv.length; index += 2) {
      if (argv[index] !== "--input") return undefined;
      const inputPath = argv[index + 1];
      if (!inputPath || inputPath.startsWith("--")) return undefined;
      inputPaths.push(inputPath);
    }
    return { command: "execute", workflowPath, inputPaths };
  }

  private async maybePromptForCleanup(
    currentDirectory: string,
    run: RunRecord,
  ): Promise<void> {
    if (
      !runIsTerminal(run.status) ||
      run.workspace?.mode !== "worktree" ||
      run.workspace.worktrees.length === 0 ||
      !this.cleanupPrompt?.isInteractive()
    )
      return;
    const cleanup = this.requireCleanup();
    const claimed = await cleanup.claimPrompt(currentDirectory, run.id);
    if (!claimed) return;
    const confirmed = await this.cleanupPrompt.confirm(
      "Clean up managed worktrees? [y/N] ",
    );
    if (!confirmed) {
      await cleanup.retain(claimed);
      this.streams.stdout("Managed worktrees retained.");
      return;
    }
    const result = await cleanup.cleanup(currentDirectory, run.id, claimed);
    this.presentCleanup(result.run, result.evaluations);
  }

  private presentCleanup(
    run: RunRecord,
    evaluations: ReadonlyArray<{
      path: string;
      result: "removed" | "retained_dirty" | "failed";
      message?: string;
    }>,
  ): void {
    if (run.workspace?.mode !== "worktree") {
      this.streams.stdout(
        `Run ${run.id} uses direct mode; no managed worktrees exist.`,
      );
      return;
    }
    if (evaluations.length === 0) {
      this.streams.stdout(`Run ${run.id} has no managed worktrees.`);
      return;
    }
    for (const evaluation of evaluations) {
      if (evaluation.result === "removed")
        this.streams.stdout(`Removed clean worktree: ${evaluation.path}`);
      else if (evaluation.result === "retained_dirty")
        this.streams.stdout(
          `Retained dirty worktree requiring manual attention: ${evaluation.path}`,
        );
      else
        this.streams.stderr(
          `Failed to clean worktree ${evaluation.path}: ${evaluation.message ?? "unknown error"}`,
        );
    }
  }

  private requireCleanup(): CleanupWorktrees {
    if (!this.cleanupWorktrees)
      throw new Error("Worktree cleanup is not configured");
    return this.cleanupWorktrees;
  }
}
