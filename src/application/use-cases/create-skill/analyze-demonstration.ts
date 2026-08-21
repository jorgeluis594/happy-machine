import type {
  AgentSessionId,
  AgentSessions,
  AgentTurnResult,
} from "../../../ports/agent-sessions.js";
import type {
  CaptureArtifact,
  CaptureWorkspace,
  SkillCaptureStore,
} from "../../../ports/skill-capture-store.js";
import { CreateSkillError, isCreateSkillError } from "./create-skill-errors.js";
import {
  buildAnalysisPrompt,
  validateAnalyzedMarkdown,
} from "./create-skill-prompts.js";

export interface AnalyzeDemonstrationRequest {
  currentDirectory: string;
  workspace: CaptureWorkspace;
  demonstrationSessionId: AgentSessionId;
  demonstrationArtifact: CaptureArtifact;
  signal?: AbortSignal;
}

export type AnalyzeDemonstrationResult =
  | {
      outcome: "analyzed";
      artifact: CaptureArtifact;
    }
  | {
      outcome: "canceled";
    };

export class AnalyzeDemonstration {
  constructor(
    private readonly sessions: AgentSessions,
    private readonly store: SkillCaptureStore,
  ) {}

  async analyze(
    request: AnalyzeDemonstrationRequest,
  ): Promise<AnalyzeDemonstrationResult> {
    const analysisSessionId = await this.createAnalysisSession(
      request.currentDirectory,
    );

    if (analysisSessionId === request.demonstrationSessionId) {
      throw analysisFailed(
        new Error(
          "The analysis session was not isolated from the demonstration.",
        ),
      );
    }

    let turnResult: AgentTurnResult;
    try {
      turnResult = await this.sessions.runTurn(analysisSessionId, {
        prompt: buildAnalysisPrompt(
          request.demonstrationArtifact.agentReference,
        ),
        filesystem: "read-only",
        network: false,
        expectedResult: "markdown",
        readableResources: [request.demonstrationArtifact.agentReference],
        signal: request.signal,
      });
    } catch (cause) {
      return this.disposeAfterFailure(analysisSessionId, analysisFailed(cause));
    }

    if (turnResult.status === "interrupted") {
      await this.disposeAnalysisSession(analysisSessionId);
      return { outcome: "canceled" };
    }

    if (turnResult.status === "failed") {
      return this.disposeAfterFailure(analysisSessionId, analysisFailed());
    }

    let markdown: string;
    try {
      markdown = validateAnalyzedMarkdown(turnResult.content);
    } catch (error) {
      return this.disposeAfterFailure(analysisSessionId, error);
    }

    let artifact: CaptureArtifact;
    try {
      artifact = await this.store.writeSkillContext(
        request.workspace,
        markdown,
      );
    } catch (cause) {
      return this.disposeAfterFailure(analysisSessionId, analysisFailed(cause));
    }

    await this.crossPrivacyBoundary(
      analysisSessionId,
      request.demonstrationSessionId,
      request.demonstrationArtifact,
    );

    return { outcome: "analyzed", artifact };
  }

  private async createAnalysisSession(
    currentDirectory: string,
  ): Promise<AgentSessionId> {
    try {
      return await this.sessions.createSession({
        currentDirectory,
        retention: "managed",
      });
    } catch (cause) {
      throw analysisFailed(cause);
    }
  }

  private async disposeAfterFailure(
    analysisSessionId: AgentSessionId,
    error: unknown,
  ): Promise<never> {
    try {
      await this.sessions.disposeSession(analysisSessionId);
    } catch (cleanupCause) {
      const primaryError = isCreateSkillError(error)
        ? error
        : analysisFailed(error);
      throw new CreateSkillError(
        primaryError.code,
        primaryError.stage,
        primaryError.message,
        {
          cause: new AggregateError(
            [primaryError.cause ?? primaryError, cleanupCause],
            "Analysis failed and its session could not be disposed.",
          ),
        },
      );
    }

    throw error;
  }

  private async disposeAnalysisSession(
    analysisSessionId: AgentSessionId,
  ): Promise<void> {
    try {
      await this.sessions.disposeSession(analysisSessionId);
    } catch (cause) {
      throw cleanupFailed(cause);
    }
  }

  private async crossPrivacyBoundary(
    analysisSessionId: AgentSessionId,
    demonstrationSessionId: AgentSessionId,
    demonstrationArtifact: CaptureArtifact,
  ): Promise<void> {
    const cleanupResults = await Promise.allSettled([
      this.store.removeArtifact(demonstrationArtifact),
      this.sessions.disposeSession(demonstrationSessionId),
      this.sessions.disposeSession(analysisSessionId),
    ]);
    const failures = cleanupResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );

    if (failures.length > 0) {
      throw cleanupFailed(
        new AggregateError(
          failures,
          "The raw demonstration privacy boundary was incomplete.",
        ),
      );
    }
  }
}

function analysisFailed(cause?: unknown): CreateSkillError {
  return new CreateSkillError(
    "analysis_failed",
    "analysis",
    "The workflow demonstration could not be analyzed.",
    cause === undefined ? {} : { cause },
  );
}

function cleanupFailed(cause: unknown): CreateSkillError {
  return new CreateSkillError(
    "cleanup_failed",
    "cleanup",
    "Temporary demonstration data could not be fully removed.",
    { cause },
  );
}
