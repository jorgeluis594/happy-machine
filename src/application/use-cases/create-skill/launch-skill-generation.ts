import type {
  AgentSessionId,
  AgentSessions,
  InteractiveExit,
} from "../../../ports/agent-sessions.js";
import type { CaptureArtifact } from "../../../ports/skill-capture-store.js";
import { CreateSkillError } from "./create-skill-errors.js";
import { buildGenerationPrompt } from "./create-skill-prompts.js";

export interface LaunchSkillGenerationRequest {
  currentDirectory: string;
  workflowDescription: string;
  skillContextArtifact: CaptureArtifact;
  previousSessionIds: readonly [AgentSessionId, AgentSessionId];
  signal?: AbortSignal;
}

export type LaunchSkillGenerationResult =
  | {
      outcome: "completed";
      sessionId: AgentSessionId;
    }
  | {
      outcome: "canceled";
      sessionId: AgentSessionId;
    };

export class LaunchSkillGeneration {
  constructor(private readonly sessions: AgentSessions) {}

  async launch(
    request: LaunchSkillGenerationRequest,
  ): Promise<LaunchSkillGenerationResult> {
    const sessionId = await this.createGenerationSession(
      request.currentDirectory,
    );

    if (request.previousSessionIds.includes(sessionId)) {
      await this.failBeforeStartup(
        sessionId,
        new Error("The generation session was not isolated from prior stages."),
      );
    }

    let interactiveExit: InteractiveExit;
    try {
      interactiveExit = await this.sessions.runInteractive(sessionId, {
        initialPrompt: buildGenerationPrompt(
          request.workflowDescription,
          request.skillContextArtifact.agentReference,
        ),
        readableResources: [request.skillContextArtifact.agentReference],
        signal: request.signal,
      });
    } catch (cause) {
      return this.failBeforeStartup(sessionId, cause);
    }

    if (interactiveExit.reason === "interrupted") {
      return { outcome: "canceled", sessionId };
    }

    if (isSuccessfulExit(interactiveExit)) {
      return { outcome: "completed", sessionId };
    }

    throw generationStartFailed();
  }

  private async createGenerationSession(
    currentDirectory: string,
  ): Promise<AgentSessionId> {
    try {
      return await this.sessions.createSession({
        currentDirectory,
        retention: "persistent",
      });
    } catch (cause) {
      throw generationStartFailed(cause);
    }
  }

  private async failBeforeStartup(
    sessionId: AgentSessionId,
    cause: unknown,
  ): Promise<never> {
    const primaryError = generationStartFailed(cause);

    try {
      await this.sessions.disposeSession(sessionId);
    } catch (cleanupCause) {
      throw new CreateSkillError(
        primaryError.code,
        primaryError.stage,
        primaryError.message,
        {
          cause: new AggregateError(
            [primaryError.cause ?? primaryError, cleanupCause],
            "Generation startup failed and its incomplete session could not be disposed.",
          ),
          cleanupFailures: [cleanupCause],
        },
      );
    }

    throw primaryError;
  }
}

function isSuccessfulExit(exit: InteractiveExit): boolean {
  return (
    exit.reason === "normal" &&
    (exit.exitCode === undefined || exit.exitCode === 0)
  );
}

function generationStartFailed(cause?: unknown): CreateSkillError {
  return new CreateSkillError(
    "generation_start_failed",
    "generation",
    "The skill-generation session could not be started.",
    cause === undefined ? {} : { cause },
  );
}
