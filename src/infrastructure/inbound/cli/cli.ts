import type { ExecuteWorkflow } from '../../../application/use-cases/execute-workflow.js';

export interface CliStreams { stdout(message: string): void; stderr(message: string): void }

export class Cli {
  constructor(private readonly executeWorkflow: ExecuteWorkflow, private readonly streams: CliStreams) {}

  async run(argv: string[], currentDirectory: string): Promise<number> {
    if (argv.length !== 2 || argv[0] !== 'execute') {
      this.streams.stderr('Usage: happy-machine execute WORKFLOW_PATH');
      return 1;
    }
    try {
      const run = await this.executeWorkflow.execute({
        workflowPath: argv[1]!, currentDirectory,
        onRunAllocated: (id) => this.streams.stdout(id),
      });
      this.streams.stdout(`Run ${run.id}: ${run.status}`);
      return run.status === 'succeeded' ? 0 : 1;
    } catch (error) {
      this.streams.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
}
