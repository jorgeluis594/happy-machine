import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { ExecuteWorkflow } from "./application/use-cases/execute-workflow.js";
import { ProjectWorkspaceCoordinator } from "./application/services/project-workspace-coordinator.js";
import { CancelWorkflow } from "./application/use-cases/cancel-workflow.js";
import { RecoverWorkflow } from "./application/use-cases/recover-workflow.js";
import { InspectRuns } from "./application/use-cases/inspect-runs.js";
import { Cli } from "./infrastructure/inbound/cli/cli.js";
import { FilesystemProjectDefinitions } from "./infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";
import { GitProjectWorkspaces } from "./infrastructure/outbound/project-workspaces/git/git-project-workspaces.js";
import { FilesystemRunRepository } from "./infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";
import { OrcaTaskExecutor } from "./infrastructure/outbound/task-executor/orca/orca-task-executor.js";

export function createProcessEntryPoint(): (
  argv: string[],
  currentDirectory: string,
) => Promise<number> {
  const definitions = new FilesystemProjectDefinitions();
  const runs = new FilesystemRunRepository();
  const workspaces = new GitProjectWorkspaces();
  const workspaceCoordinator = new ProjectWorkspaceCoordinator(workspaces);
  const executor = new OrcaTaskExecutor();
  const now = () => new Date();
  const sleeper = (milliseconds: number, signal?: AbortSignal) =>
    wait(milliseconds, undefined, { signal });
  const useCase = new ExecuteWorkflow(
    definitions,
    runs,
    executor,
    now,
    randomUUID,
    sleeper,
    workspaceCoordinator,
  );
  const recover = new RecoverWorkflow(
    runs,
    executor,
    now,
    (milliseconds) => sleeper(milliseconds),
    workspaceCoordinator,
  );
  const cancel = new CancelWorkflow(
    runs,
    executor,
    now,
    sleeper,
    workspaceCoordinator,
  );
  const cli = new Cli(useCase, recover, cancel, new InspectRuns(runs, now), {
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`),
  });
  return async (argv, currentDirectory) => {
    const controller = new AbortController();
    const detach = () => controller.abort();
    process.once("SIGINT", detach);
    process.once("SIGHUP", detach);
    try {
      return await cli.run(argv, currentDirectory, controller.signal);
    } finally {
      process.off("SIGINT", detach);
      process.off("SIGHUP", detach);
    }
  };
}
