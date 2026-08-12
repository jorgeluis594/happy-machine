import type { ExecuteWorkflow } from "../../../application/use-cases/execute-workflow.js";
import type { RecoverWorkflow } from "../../../application/use-cases/recover-workflow.js";
import { ControllerDetachedError } from "../../../application/services/controller-detachment.js";
import type { InspectRuns } from "../../../application/use-cases/inspect-runs.js";
import { RunPresenter } from "./run-presenter.js";

export interface CliStreams {
  stdout(message: string): void;
  stderr(message: string): void;
}

export class Cli {
  constructor(
    private readonly executeWorkflow: ExecuteWorkflow,
    private readonly recoverWorkflow: RecoverWorkflow,
    private readonly inspectRuns: InspectRuns,
    private readonly streams: CliStreams,
    private readonly presenter = new RunPresenter(),
  ) {}

  async run(
    argv: string[],
    currentDirectory: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const request = this.request(argv);
    if (!request) {
      this.streams.stderr(
        "Usage: happy-machine execute WORKFLOW_PATH [--input DOCUMENT.md ...] | happy-machine resume RUN_ID | happy-machine status RUN_ID | happy-machine history [RUN_ID]",
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
      const run =
        request.command === "execute"
          ? await this.executeWorkflow.execute({
              workflowPath: request.workflowPath,
              currentDirectory,
              inputPaths: request.inputPaths,
              onRunAllocated: (id) => this.streams.stdout(id),
              signal,
            })
          : await this.recoverWorkflow.recover({
              projectRoot: currentDirectory,
              runId: request.runId,
              controllerId: `${request.runId}:resume:${process.pid}`,
              signal,
            });
      this.streams.stdout(`Run ${run.id}: ${run.status}`);
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
    | { command: "status"; runId: string }
    | { command: "history"; runId?: string }
    | undefined {
    if (argv[0] === "resume" && argv.length === 2 && argv[1])
      return { command: "resume", runId: argv[1] };
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
}
