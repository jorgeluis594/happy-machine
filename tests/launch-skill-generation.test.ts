import { describe, expect, it, vi } from "vitest";
import {
  LaunchSkillGeneration,
  type LaunchSkillGenerationRequest,
} from "../src/application/use-cases/create-skill/launch-skill-generation.js";
import { CreateSkillError } from "../src/application/use-cases/create-skill/create-skill-errors.js";
import { buildGenerationPrompt } from "../src/application/use-cases/create-skill/create-skill-prompts.js";
import type {
  AgentSessions,
  InteractiveExit,
} from "../src/ports/agent-sessions.js";
import type { CaptureArtifact } from "../src/ports/skill-capture-store.js";

const skillContextArtifact: CaptureArtifact = {
  id: "context-artifact",
  agentReference: "artifact://capture/skill-context.md",
};

function fixture(
  options: {
    generationSessionId?: string;
    createSessionError?: Error;
    interactiveExit?: InteractiveExit;
    runInteractiveError?: Error;
    disposeSessionError?: Error;
  } = {},
) {
  const generationSessionId =
    options.generationSessionId ?? "generation-session";
  const createSession = vi.fn<AgentSessions["createSession"]>(() =>
    options.createSessionError
      ? Promise.reject(options.createSessionError)
      : Promise.resolve(generationSessionId),
  );
  const runInteractive = vi.fn<AgentSessions["runInteractive"]>(() =>
    options.runInteractiveError
      ? Promise.reject(options.runInteractiveError)
      : Promise.resolve(
          options.interactiveExit ?? { reason: "normal", exitCode: 0 },
        ),
  );
  const disposeSession = vi.fn<AgentSessions["disposeSession"]>(() =>
    options.disposeSessionError
      ? Promise.reject(options.disposeSessionError)
      : Promise.resolve(),
  );
  const runTurn = vi.fn<AgentSessions["runTurn"]>(() =>
    Promise.resolve({ status: "completed" }),
  );
  const readConversation = vi.fn<AgentSessions["readConversation"]>(() =>
    Promise.resolve({ turns: [] }),
  );
  const sessions: AgentSessions = {
    checkCompatibility: vi.fn<AgentSessions["checkCompatibility"]>(() =>
      Promise.resolve(),
    ),
    start: vi.fn<AgentSessions["start"]>(() => Promise.resolve()),
    createSession,
    runInteractive,
    runTurn,
    readConversation,
    disposeSession,
    stop: vi.fn<AgentSessions["stop"]>(() => Promise.resolve()),
  };
  const request: LaunchSkillGenerationRequest = {
    currentDirectory: "/project",
    workflowDescription: "Investigate and fix a production failure",
    skillContextArtifact,
    previousSessionIds: ["demonstration-session", "analysis-session"],
  };

  return {
    createSession,
    disposeSession,
    readConversation,
    request,
    runInteractive,
    runTurn,
    stage: new LaunchSkillGeneration(sessions),
  };
}

describe("LaunchSkillGeneration", () => {
  it.each<InteractiveExit>([
    { reason: "normal" },
    { reason: "normal", exitCode: 0 },
  ])(
    "launches one persistent generation TUI and returns completion: %j",
    async (interactiveExit) => {
      const {
        createSession,
        disposeSession,
        readConversation,
        request,
        runInteractive,
        runTurn,
        stage,
      } = fixture({ interactiveExit });
      const signal = new AbortController().signal;

      await expect(stage.launch({ ...request, signal })).resolves.toEqual({
        outcome: "completed",
        sessionId: "generation-session",
      });

      expect(createSession).toHaveBeenCalledOnce();
      expect(createSession).toHaveBeenCalledWith({
        currentDirectory: "/project",
        retention: "persistent",
      });
      expect(runInteractive).toHaveBeenCalledOnce();
      expect(runInteractive).toHaveBeenCalledWith("generation-session", {
        initialPrompt: buildGenerationPrompt(
          request.workflowDescription,
          skillContextArtifact.agentReference,
        ),
        readableResources: [skillContextArtifact.agentReference],
        signal,
      });
      expect(runTurn).not.toHaveBeenCalled();
      expect(readConversation).not.toHaveBeenCalled();
      expect(disposeSession).not.toHaveBeenCalled();
    },
  );

  it("returns cancellation and retains the persistent thread after interruption", async () => {
    const { disposeSession, request, runInteractive, stage } = fixture({
      interactiveExit: { reason: "interrupted" },
    });
    const signal = new AbortController().signal;

    await expect(stage.launch({ ...request, signal })).resolves.toEqual({
      outcome: "canceled",
      sessionId: "generation-session",
    });

    expect(runInteractive).toHaveBeenCalledWith(
      "generation-session",
      expect.objectContaining({ signal }),
    );
    expect(disposeSession).not.toHaveBeenCalled();
  });

  it.each<InteractiveExit>([
    { reason: "failed" },
    { reason: "failed", exitCode: 9 },
    { reason: "normal", exitCode: 3 },
  ])(
    "reports an abnormal post-start TUI exit without deleting its thread: %j",
    async (interactiveExit) => {
      const { disposeSession, request, stage } = fixture({ interactiveExit });

      await expect(stage.launch(request)).rejects.toMatchObject({
        code: "generation_start_failed",
        stage: "generation",
      });

      expect(disposeSession).not.toHaveBeenCalled();
    },
  );

  it("disposes a generation session that reuses a prior stage ID", async () => {
    const { disposeSession, request, runInteractive, stage } = fixture({
      generationSessionId: "analysis-session",
    });

    await expect(stage.launch(request)).rejects.toMatchObject({
      code: "generation_start_failed",
      stage: "generation",
    });

    expect(runInteractive).not.toHaveBeenCalled();
    expect(disposeSession).toHaveBeenCalledOnce();
    expect(disposeSession).toHaveBeenCalledWith("analysis-session");
  });

  it("maps session-creation failure without attempting disposal", async () => {
    const cause = new Error("thread creation failed");
    const { disposeSession, request, stage } = fixture({
      createSessionError: cause,
    });

    await expect(stage.launch(request)).rejects.toMatchObject({
      code: "generation_start_failed",
      stage: "generation",
      cause,
    });

    expect(disposeSession).not.toHaveBeenCalled();
  });

  it("disposes the incomplete persistent session when TUI startup rejects", async () => {
    const cause = new Error("TUI did not start");
    const { disposeSession, request, stage } = fixture({
      runInteractiveError: cause,
    });

    await expect(stage.launch(request)).rejects.toMatchObject({
      code: "generation_start_failed",
      stage: "generation",
      cause,
    });

    expect(disposeSession).toHaveBeenCalledOnce();
    expect(disposeSession).toHaveBeenCalledWith("generation-session");
  });

  it("preserves launch and disposal failures when startup cleanup also fails", async () => {
    const primaryCause = new Error("TUI did not start");
    const cleanupCause = new Error("thread delete failed");
    const { request, stage } = fixture({
      runInteractiveError: primaryCause,
      disposeSessionError: cleanupCause,
    });

    await expect(stage.launch(request)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CreateSkillError);
      expect(error).toMatchObject({
        code: "generation_start_failed",
        stage: "generation",
      });
      expect((error as CreateSkillError).cause).toBeInstanceOf(AggregateError);
      const aggregate = (error as CreateSkillError).cause as AggregateError;
      expect(aggregate.errors).toContain(primaryCause);
      expect(aggregate.errors).toContain(cleanupCause);
      return true;
    });
  });
});
