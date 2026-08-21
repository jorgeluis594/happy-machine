import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as wait } from "node:timers/promises";
import { ProjectWorkspaceCoordinator } from "./application/services/project-workspace-coordinator.js";
import { AnalyzeDemonstration } from "./application/use-cases/create-skill/analyze-demonstration.js";
import { CaptureDemonstration } from "./application/use-cases/create-skill/capture-demonstration.js";
import { CreateSkill } from "./application/use-cases/create-skill/create-skill.js";
import { LaunchSkillGeneration } from "./application/use-cases/create-skill/launch-skill-generation.js";
import { CancelWorkflow } from "./application/use-cases/cancel-workflow.js";
import { CleanupWorktrees } from "./application/use-cases/cleanup-worktrees.js";
import { ExecuteWorkflow } from "./application/use-cases/execute-workflow.js";
import { InspectRuns } from "./application/use-cases/inspect-runs.js";
import { RecoverWorkflow } from "./application/use-cases/recover-workflow.js";
import { Cli } from "./infrastructure/inbound/cli/cli.js";
import {
  CreateSkillCommand,
  type CreateSkillTerminal,
} from "./infrastructure/inbound/cli/create-skill-command.js";
import { CreateSkillPresenter } from "./infrastructure/inbound/cli/create-skill-presenter.js";
import { CliDiagnostics } from "./infrastructure/inbound/cli/debug-presenter.js";
import { CodexAppServerSessions } from "./infrastructure/outbound/agent-sessions/codex-app-server/codex-app-server-sessions.js";
import { CodexProcessRuntime } from "./infrastructure/outbound/agent-sessions/codex-app-server/codex-process-runtime.js";
import { FilesystemExclusiveOperationLock } from "./infrastructure/outbound/exclusive-operation-lock/filesystem/filesystem-exclusive-operation-lock.js";
import { FilesystemProjectDefinitions } from "./infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";
import { GitProjectWorkspaces } from "./infrastructure/outbound/project-workspaces/git/git-project-workspaces.js";
import { FilesystemRunRepository } from "./infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";
import { FilesystemSkillCaptureStore } from "./infrastructure/outbound/skill-capture-store/filesystem/filesystem-skill-capture-store.js";
import { OrcaTaskExecutor } from "./infrastructure/outbound/task-executor/orca/orca-task-executor.js";

type HandledSignal = "SIGINT" | "SIGHUP";

export interface ProcessSignalSource {
  once(signal: HandledSignal, listener: () => void): unknown;
  off(signal: HandledSignal, listener: () => void): unknown;
}

export interface ProcessEntryPointOptions {
  codexExecutable?: string;
  environment?: NodeJS.ProcessEnv;
  temporaryDirectory?: string;
  processId?: number;
  userId?: number;
  processIsAlive?: (processId: number) => boolean;
  now?: () => Date;
  randomId?: () => string;
  streams?: {
    stdout(message: string): void;
    stderr(message: string): void;
  };
  createSkillTerminal?: CreateSkillTerminal;
  signalSource?: ProcessSignalSource;
}

export function createProcessEntryPoint(
  options: ProcessEntryPointOptions = {},
): (argv: string[], currentDirectory: string) => Promise<number> {
  const signalSource = options.signalSource ?? process;

  return async (argv, currentDirectory) => {
    const controller = new AbortController();
    const detach = () => controller.abort();
    signalSource.once("SIGINT", detach);
    signalSource.once("SIGHUP", detach);
    try {
      return await createCli(currentDirectory, options).run(
        argv,
        currentDirectory,
        controller.signal,
      );
    } finally {
      signalSource.off("SIGINT", detach);
      signalSource.off("SIGHUP", detach);
    }
  };
}

function createCli(
  currentDirectory: string,
  options: ProcessEntryPointOptions,
): Cli {
  const environment = options.environment ?? process.env;
  const temporaryDirectory = path.resolve(
    options.temporaryDirectory ?? os.tmpdir(),
  );
  const processId = options.processId ?? process.pid;
  const userId = options.userId ?? process.getuid?.();
  const processIsAlive = options.processIsAlive ?? defaultProcessIsAlive;
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const streams = options.streams ?? {
    stdout: (message: string) => process.stdout.write(`${message}\n`),
    stderr: (message: string) => process.stderr.write(`${message}\n`),
  };
  const terminal =
    options.createSkillTerminal ??
    createProcessTerminal(process.stdin, process.stdout);

  const definitions = new FilesystemProjectDefinitions();
  const runs = new FilesystemRunRepository();
  const workspaces = new GitProjectWorkspaces();
  const workspaceCoordinator = new ProjectWorkspaceCoordinator(workspaces);
  const diagnostics = new CliDiagnostics((message) => streams.stderr(message));
  const executor = new OrcaTaskExecutor(undefined, diagnostics);
  const sleeper = (milliseconds: number, signal?: AbortSignal) =>
    wait(milliseconds, undefined, { signal });
  const executeWorkflow = new ExecuteWorkflow(
    definitions,
    runs,
    executor,
    now,
    randomUUID,
    sleeper,
    workspaceCoordinator,
    diagnostics,
  );
  const recoverWorkflow = new RecoverWorkflow(
    runs,
    executor,
    now,
    (milliseconds) => sleeper(milliseconds),
    workspaceCoordinator,
    diagnostics,
  );
  const cancelWorkflow = new CancelWorkflow(
    runs,
    executor,
    now,
    sleeper,
    workspaceCoordinator,
    diagnostics,
  );
  const cleanupWorktrees = new CleanupWorktrees(runs, workspaces, now);

  const captureStore = new FilesystemSkillCaptureStore({
    temporaryDirectory,
    processId,
    userId,
    processIsAlive,
    now,
  });
  const operationLock = new FilesystemExclusiveOperationLock({
    temporaryDirectory,
    processId,
    userId,
    processIsAlive,
    now,
    randomId,
  });
  const runtime = new CodexProcessRuntime({
    executable: options.codexExecutable ?? "codex",
    socketPath: path.join(temporaryDirectory, `hm-cs-${randomId()}.sock`),
    currentDirectory,
    environment,
  });
  const sessions = new CodexAppServerSessions({ runtime });
  const createSkill = new CreateSkill(
    operationLock,
    sessions,
    captureStore,
    new CaptureDemonstration(sessions, captureStore),
    new AnalyzeDemonstration(sessions, captureStore),
    new LaunchSkillGeneration(sessions),
  );
  const createSkillCommand = new CreateSkillCommand(
    createSkill,
    terminal,
    streams,
    new CreateSkillPresenter(),
  );

  return new Cli(
    executeWorkflow,
    recoverWorkflow,
    cancelWorkflow,
    new InspectRuns(runs, now),
    streams,
    undefined,
    cleanupWorktrees,
    {
      isInteractive: () =>
        terminal.isStdinInteractive() && terminal.isStdoutInteractive(),
      confirm: async (message) => {
        try {
          return (
            (await terminal.question(message)).trim().toLowerCase() === "y"
          );
        } catch {
          return false;
        }
      },
    },
    undefined,
    diagnostics,
    createSkillCommand,
  );
}

function createProcessTerminal(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): CreateSkillTerminal {
  return {
    isStdinInteractive: () => Boolean(stdin.isTTY),
    isStdoutInteractive: () => Boolean(stdout.isTTY),
    question: async (prompt) => {
      const input = createInterface({ input: stdin, output: stdout });
      try {
        return await input.question(prompt);
      } finally {
        input.close();
      }
    },
  };
}

function defaultProcessIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
