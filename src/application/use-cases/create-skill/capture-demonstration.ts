import type {
  AgentSessionId,
  AgentSessions,
  InteractiveExit,
} from "../../../ports/agent-sessions.js";
import type {
  CaptureArtifact,
  CaptureWorkspace,
  SkillCaptureStore,
} from "../../../ports/skill-capture-store.js";
import { CreateSkillError } from "./create-skill-errors.js";
import { serializeAgentConversation } from "./serialize-agent-conversation.js";

export interface CaptureDemonstrationRequest {
  currentDirectory: string;
  workflowDescription: string;
  workspace: CaptureWorkspace;
  signal?: AbortSignal;
}

export type CaptureDemonstrationResult =
  | {
      outcome: "captured";
      sessionId: AgentSessionId;
      artifact: CaptureArtifact;
    }
  | {
      outcome: "canceled";
      sessionId: AgentSessionId;
    };

export class CaptureDemonstration {
  constructor(
    private readonly sessions: AgentSessions,
    private readonly store: SkillCaptureStore,
  ) {}

  async capture(
    request: CaptureDemonstrationRequest,
  ): Promise<CaptureDemonstrationResult> {
    const sessionId = await this.createSession(request.currentDirectory);
    const interactiveExit = await this.runInteractive(
      sessionId,
      request.signal,
    );

    if (interactiveExit.reason === "interrupted") {
      return { outcome: "canceled", sessionId };
    }
    if (!isSuccessfulExit(interactiveExit)) {
      throw demonstrationFailed();
    }

    let conversation;
    try {
      conversation = await this.sessions.readConversation(sessionId);
    } catch (cause) {
      throw demonstrationFailed(cause);
    }

    if (!conversation.turns.some((turn) => turn.items.length > 0)) {
      throw new CreateSkillError(
        "demonstration_empty",
        "demonstration",
        "The demonstration contained no observable conversation.",
      );
    }

    const markdown = serializeAgentConversation(
      request.workflowDescription,
      conversation,
    );
    let artifact: CaptureArtifact;
    try {
      artifact = await this.store.writeDemonstration(
        request.workspace,
        markdown,
      );
    } catch (cause) {
      throw demonstrationFailed(cause);
    }

    return { outcome: "captured", sessionId, artifact };
  }

  private async createSession(
    currentDirectory: string,
  ): Promise<AgentSessionId> {
    try {
      return await this.sessions.createSession({
        currentDirectory,
        retention: "managed",
      });
    } catch (cause) {
      throw demonstrationFailed(cause);
    }
  }

  private async runInteractive(
    sessionId: AgentSessionId,
    signal: AbortSignal | undefined,
  ): Promise<InteractiveExit> {
    try {
      return await this.sessions.runInteractive(sessionId, { signal });
    } catch (cause) {
      throw demonstrationFailed(cause);
    }
  }
}

function isSuccessfulExit(exit: InteractiveExit): boolean {
  return (
    exit.reason === "normal" &&
    (exit.exitCode === undefined || exit.exitCode === 0)
  );
}

function demonstrationFailed(cause?: unknown): CreateSkillError {
  return new CreateSkillError(
    "demonstration_failed",
    "demonstration",
    "The workflow demonstration could not be captured.",
    cause === undefined ? {} : { cause },
  );
}
