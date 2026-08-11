import { randomUUID } from 'node:crypto';
import { ExecuteWorkflow } from './application/use-cases/execute-workflow.js';
import { Cli } from './infrastructure/inbound/cli/cli.js';
import { FilesystemProjectDefinitions } from './infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js';
import { FilesystemRunRepository } from './infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js';
import { OrcaTaskExecutor } from './infrastructure/outbound/task-executor/orca/orca-task-executor.js';

export function createProcessEntryPoint(): (argv: string[], currentDirectory: string) => Promise<number> {
  const useCase = new ExecuteWorkflow(
    new FilesystemProjectDefinitions(), new FilesystemRunRepository(), new OrcaTaskExecutor(), () => new Date(), randomUUID,
  );
  const cli = new Cli(useCase, {
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`),
  });
  return (argv, currentDirectory) => cli.run(argv, currentDirectory);
}
