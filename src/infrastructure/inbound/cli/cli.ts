import type { ExecuteWorkflow } from "../../../application/use-cases/execute-workflow.js";

export interface CliStreams {
  stdout(message: string): void;
  stderr(message: string): void;
}

export class Cli {
  constructor(
    private readonly executeWorkflow: ExecuteWorkflow,
    private readonly streams: CliStreams,
  ) {}

  async run(argv: string[], currentDirectory: string): Promise<number> {
    const request = this.executeRequest(argv);
    if (!request) {
      this.streams.stderr(
        "Usage: happy-machine execute WORKFLOW_PATH [--input DOCUMENT.md ...]",
      );
      return 1;
    }
    try {
      const run = await this.executeWorkflow.execute({
        workflowPath: request.workflowPath,
        currentDirectory,
        inputPaths: request.inputPaths,
        onRunAllocated: (id) => this.streams.stdout(id),
      });
      this.streams.stdout(`Run ${run.id}: ${run.status}`);
      return run.status === "succeeded" ? 0 : 1;
    } catch (error) {
      this.streams.stderr(
        error instanceof Error ? error.message : String(error),
      );
      return 1;
    }
  }

  private executeRequest(
    argv: string[],
  ): { workflowPath: string; inputPaths: string[] } | undefined {
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
    return { workflowPath, inputPaths };
  }
}
