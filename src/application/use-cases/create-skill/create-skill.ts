import {
  AgentRuntimeIncompatibleError,
  type AgentSessionId,
  type AgentSessions,
} from "../../../ports/agent-sessions.js";
import {
  ExclusiveOperationAlreadyActiveError,
  type ExclusiveOperationLock,
  type OperationLease,
} from "../../../ports/exclusive-operation-lock.js";
import type {
  CaptureWorkspace,
  SkillCaptureStore,
} from "../../../ports/skill-capture-store.js";
import { SkillCaptureCleanupError } from "../../../ports/skill-capture-store.js";
import type {
  AnalyzeDemonstration,
  AnalyzeDemonstrationResult,
} from "./analyze-demonstration.js";
import type {
  CaptureDemonstration,
  CaptureDemonstrationResult,
} from "./capture-demonstration.js";
import { CreateSkillError, isCreateSkillError } from "./create-skill-errors.js";
import type {
  LaunchSkillGeneration,
  LaunchSkillGenerationResult,
} from "./launch-skill-generation.js";

export interface CreateSkillRequest {
  workflowDescription: string;
  currentDirectory: string;
  confirmRecording: () => Promise<boolean>;
  signal?: AbortSignal;
}

export type CreateSkillResult =
  | { outcome: "completed" }
  | {
      outcome: "canceled";
      stage: "consent" | "demonstration" | "analysis" | "generation";
    };

export interface CaptureDemonstrationStage {
  capture(
    request: Parameters<CaptureDemonstration["capture"]>[0],
  ): Promise<CaptureDemonstrationResult>;
}

export interface AnalyzeDemonstrationStage {
  analyze(
    request: Parameters<AnalyzeDemonstration["analyze"]>[0],
  ): Promise<AnalyzeDemonstrationResult>;
}

export interface LaunchSkillGenerationStage {
  launch(
    request: Parameters<LaunchSkillGeneration["launch"]>[0],
  ): Promise<LaunchSkillGenerationResult>;
}

interface ExecutionResources {
  lease?: OperationLease;
  workspace?: CaptureWorkspace;
  runtimeOwned: boolean;
  demonstrationSessionId?: AgentSessionId;
}

interface CleanupResult {
  failures: unknown[];
  remainingWorkspaces: string[];
}

export class CreateSkill {
  constructor(
    private readonly lock: ExclusiveOperationLock,
    private readonly sessions: AgentSessions,
    private readonly store: SkillCaptureStore,
    private readonly captureDemonstration: CaptureDemonstrationStage,
    private readonly analyzeDemonstration: AnalyzeDemonstrationStage,
    private readonly launchSkillGeneration: LaunchSkillGenerationStage,
  ) {}

  async execute(request: CreateSkillRequest): Promise<CreateSkillResult> {
    const resources: ExecutionResources = { runtimeOwned: false };
    let result: CreateSkillResult | undefined;
    let primaryError: CreateSkillError | undefined;
    let cleanupResult!: CleanupResult;

    try {
      result = await this.run(request, resources);
    } catch (error) {
      primaryError = normalizeUnexpectedError(error);
    } finally {
      cleanupResult = await this.cleanup(resources);
    }

    if (primaryError) {
      if (cleanupResult.failures.length > 0) {
        throw attachCleanupFailures(primaryError, cleanupResult);
      }
      throw primaryError;
    }

    if (cleanupResult.failures.length > 0) {
      throw cleanupFailed(
        cleanupResult.failures,
        cleanupResult.remainingWorkspaces,
      );
    }

    if (!result) {
      throw new CreateSkillError(
        "cleanup_failed",
        "cleanup",
        "The create-skill operation ended without a result.",
      );
    }
    return result;
  }

  private async run(
    request: CreateSkillRequest,
    resources: ExecutionResources,
  ): Promise<CreateSkillResult> {
    resources.lease = await this.acquireLease();
    await this.checkCompatibility();

    if (!(await this.confirmRecording(request.confirmRecording))) {
      return { outcome: "canceled", stage: "consent" };
    }

    await this.prepareCapture(resources);
    await this.startRuntime(resources);

    const capture = await this.capture(request, resources.workspace!);
    resources.demonstrationSessionId = capture.sessionId;
    if (capture.outcome === "canceled") {
      return { outcome: "canceled", stage: "demonstration" };
    }

    const analysis = await this.analyze(request, resources.workspace!, capture);
    if (analysis.outcome === "canceled") {
      return { outcome: "canceled", stage: "analysis" };
    }
    if (analysis.sessionId === capture.sessionId) {
      throw new CreateSkillError(
        "analysis_failed",
        "analysis",
        "The analysis session was not isolated from the demonstration.",
      );
    }

    resources.demonstrationSessionId = undefined;
    const generation = await this.launch(request, capture, analysis);
    return generation.outcome === "canceled"
      ? { outcome: "canceled", stage: "generation" }
      : { outcome: "completed" };
  }

  private async acquireLease(): Promise<OperationLease> {
    try {
      return await this.lock.acquire("create-skill");
    } catch (cause) {
      if (cause instanceof ExclusiveOperationAlreadyActiveError) {
        throw new CreateSkillError(
          "capture_already_active",
          "setup",
          "Another create-skill capture is already active.",
          { cause },
        );
      }
      throw new CreateSkillError(
        "cleanup_failed",
        "cleanup",
        "Exclusive create-skill ownership could not be established.",
        { cause },
      );
    }
  }

  private async checkCompatibility(): Promise<void> {
    try {
      await this.sessions.checkCompatibility();
    } catch (cause) {
      throw runtimeError(cause);
    }
  }

  private async confirmRecording(
    confirmRecording: () => Promise<boolean>,
  ): Promise<boolean> {
    try {
      return await confirmRecording();
    } catch (cause) {
      throw new CreateSkillError(
        "cleanup_failed",
        "cleanup",
        "Recording consent could not be collected.",
        { cause },
      );
    }
  }

  private async prepareCapture(resources: ExecutionResources): Promise<void> {
    try {
      await this.store.cleanupAbandoned();
      resources.workspace = await this.store.createWorkspace();
    } catch (cause) {
      throw cleanupFailed([cause]);
    }
  }

  private async startRuntime(resources: ExecutionResources): Promise<void> {
    resources.runtimeOwned = true;
    try {
      await this.sessions.start();
    } catch (cause) {
      throw runtimeError(cause);
    }
  }

  private async capture(
    request: CreateSkillRequest,
    workspace: CaptureWorkspace,
  ): Promise<CaptureDemonstrationResult> {
    try {
      return await this.captureDemonstration.capture({
        currentDirectory: request.currentDirectory,
        workflowDescription: request.workflowDescription,
        workspace,
        signal: request.signal,
      });
    } catch (cause) {
      throw stageError(
        cause,
        "demonstration_failed",
        "demonstration",
        "The workflow demonstration could not be captured.",
      );
    }
  }

  private async analyze(
    request: CreateSkillRequest,
    workspace: CaptureWorkspace,
    capture: Extract<CaptureDemonstrationResult, { outcome: "captured" }>,
  ): Promise<AnalyzeDemonstrationResult> {
    try {
      return await this.analyzeDemonstration.analyze({
        currentDirectory: request.currentDirectory,
        workspace,
        demonstrationSessionId: capture.sessionId,
        demonstrationArtifact: capture.artifact,
        signal: request.signal,
      });
    } catch (cause) {
      throw stageError(
        cause,
        "analysis_failed",
        "analysis",
        "The workflow demonstration could not be analyzed.",
      );
    }
  }

  private async launch(
    request: CreateSkillRequest,
    capture: Extract<CaptureDemonstrationResult, { outcome: "captured" }>,
    analysis: Extract<AnalyzeDemonstrationResult, { outcome: "analyzed" }>,
  ): Promise<LaunchSkillGenerationResult> {
    try {
      return await this.launchSkillGeneration.launch({
        currentDirectory: request.currentDirectory,
        workflowDescription: request.workflowDescription,
        skillContextArtifact: analysis.artifact,
        previousSessionIds: [capture.sessionId, analysis.sessionId],
        signal: request.signal,
      });
    } catch (cause) {
      throw stageError(
        cause,
        "generation_start_failed",
        "generation",
        "The skill-generation session could not be started.",
      );
    }
  }

  private async cleanup(resources: ExecutionResources): Promise<CleanupResult> {
    const failures: unknown[] = [];
    const remainingWorkspaces: string[] = [];
    const attempt = async (
      operation: () => Promise<void>,
    ): Promise<boolean> => {
      try {
        await operation();
        return true;
      } catch (error) {
        failures.push(error);
        return false;
      }
    };

    if (resources.demonstrationSessionId) {
      const sessionId = resources.demonstrationSessionId;
      if (await attempt(() => this.sessions.disposeSession(sessionId))) {
        resources.demonstrationSessionId = undefined;
      }
    }
    if (resources.runtimeOwned) {
      if (await attempt(() => this.sessions.stop())) {
        resources.runtimeOwned = false;
      }
    }
    if (resources.workspace) {
      const workspace = resources.workspace;
      if (await attempt(() => this.store.cleanup(workspace))) {
        resources.workspace = undefined;
      } else {
        remainingWorkspaces.push(workspace.id);
      }
    }
    if (resources.lease) {
      const lease = resources.lease;
      if (await attempt(() => this.lock.release(lease))) {
        resources.lease = undefined;
      }
    }

    return { failures, remainingWorkspaces };
  }
}

function runtimeError(cause: unknown): CreateSkillError {
  const incompatible = cause instanceof AgentRuntimeIncompatibleError;
  return new CreateSkillError(
    incompatible ? "agent_runtime_incompatible" : "agent_runtime_unavailable",
    "setup",
    incompatible
      ? "The agent runtime is incompatible with create-skill."
      : "The agent runtime is unavailable.",
    { cause },
  );
}

function stageError(
  cause: unknown,
  code: "demonstration_failed" | "analysis_failed" | "generation_start_failed",
  stage: "demonstration" | "analysis" | "generation",
  message: string,
): CreateSkillError {
  return isCreateSkillError(cause)
    ? cause
    : new CreateSkillError(code, stage, message, { cause });
}

function normalizeUnexpectedError(error: unknown): CreateSkillError {
  return isCreateSkillError(error)
    ? error
    : new CreateSkillError(
        "cleanup_failed",
        "cleanup",
        "The create-skill operation failed unexpectedly.",
        { cause: error },
      );
}

function cleanupFailed(
  failures: readonly unknown[],
  knownRemainingWorkspaces: readonly string[] = [],
): CreateSkillError {
  return new CreateSkillError(
    "cleanup_failed",
    "cleanup",
    "Temporary create-skill data could not be fully removed.",
    {
      cause: new AggregateError(
        failures,
        "Create-skill cleanup was incomplete.",
      ),
      cleanupFailures: failures,
      remainingWorkspaces: collectRemainingWorkspaces(
        failures,
        knownRemainingWorkspaces,
      ),
    },
  );
}

function attachCleanupFailures(
  primary: CreateSkillError,
  cleanup: CleanupResult,
): CreateSkillError {
  const cleanupFailures = cleanup.failures;
  const allCleanupFailures = [...primary.cleanupFailures, ...cleanupFailures];
  return new CreateSkillError(primary.code, primary.stage, primary.message, {
    cause: new AggregateError(
      [primary.cause ?? primary, ...cleanupFailures],
      "Create-skill failed and cleanup was incomplete.",
    ),
    cleanupFailures: allCleanupFailures,
    remainingWorkspaces: collectRemainingWorkspaces(allCleanupFailures, [
      ...primary.remainingWorkspaces,
      ...cleanup.remainingWorkspaces,
    ]),
  });
}

function collectRemainingWorkspaces(
  failures: readonly unknown[],
  known: readonly string[],
): string[] {
  const workspaces = new Set(known);
  const visit = (failure: unknown): void => {
    if (failure instanceof SkillCaptureCleanupError) {
      workspaces.add(failure.remainingWorkspace);
    }
    if (failure instanceof AggregateError) {
      for (const nested of failure.errors) visit(nested);
    }
  };
  for (const failure of failures) visit(failure);
  return [...workspaces];
}
