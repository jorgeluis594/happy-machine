import type { ExecuteWorkflow } from "../../../application/use-cases/execute-workflow.js";
import type { RecoverWorkflow } from "../../../application/use-cases/recover-workflow.js";
import { ControllerDetachedError } from "../../../application/services/controller-detachment.js";

export interface CliStreams {
  stdout(message: string): void;
  stderr(message: string): void;
}

export class Cli {
  constructor(
    private readonly executeWorkflow: ExecuteWorkflow,
    private readonly recoverWorkflow: RecoverWorkflow,
    private readonly streams: CliStreams,
  ) {}

  async run(
    argv: string[],
    currentDirectory: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const request = this.request(argv);
    if (!request) {
      this.streams.stderr(
        "Usage: happy-machine execute WORKFLOW_PATH [--input DOCUMENT.md ...] | happy-machine resume RUN_ID",
      );
      return 1;
    }
    try {
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
    | undefined {
    if (argv[0] === "resume" && argv.length === 2 && argv[1])
      return { command: "resume", runId: argv[1] };
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
