import { describe, expect, it, vi } from "vitest";
import {
  AnalyzeDemonstration,
  type AnalyzeDemonstrationRequest,
} from "../src/application/use-cases/create-skill/analyze-demonstration.js";
import { CreateSkillError } from "../src/application/use-cases/create-skill/create-skill-errors.js";
import { buildAnalysisPrompt } from "../src/application/use-cases/create-skill/create-skill-prompts.js";
import type {
  AgentSessions,
  AgentTurnResult,
} from "../src/ports/agent-sessions.js";
import type {
  CaptureArtifact,
  CaptureWorkspace,
  SkillCaptureStore,
} from "../src/ports/skill-capture-store.js";

const workspace: CaptureWorkspace = { id: "workspace-1" };
const demonstrationArtifact: CaptureArtifact = {
  id: "demonstration-artifact",
  agentReference: "artifact://capture/demonstration.md",
};
const contextArtifact: CaptureArtifact = {
  id: "context-artifact",
  agentReference: "artifact://capture/skill-context.md",
};
const markdown = "\n# Reusable workflow\n\n1. Inspect the failure.\n";

function fixture(
  options: {
    analysisSessionId?: string;
    createSessionError?: Error;
    turnResult?: AgentTurnResult;
    runTurnError?: Error;
    writeSkillContextError?: Error;
    removeArtifactError?: Error;
    demonstrationDisposalError?: Error;
    analysisDisposalError?: Error;
  } = {},
) {
  const events: string[] = [];
  const analysisSessionId = options.analysisSessionId ?? "analysis-session";
  const createSession = vi.fn<AgentSessions["createSession"]>(() => {
    events.push("create-analysis-session");
    return options.createSessionError
      ? Promise.reject(options.createSessionError)
      : Promise.resolve(analysisSessionId);
  });
  const runTurn = vi.fn<AgentSessions["runTurn"]>(() => {
    events.push("run-analysis-turn");
    return options.runTurnError
      ? Promise.reject(options.runTurnError)
      : Promise.resolve(
          options.turnResult ?? { status: "completed", content: markdown },
        );
  });
  const disposeSession = vi.fn<AgentSessions["disposeSession"]>((sessionId) => {
    events.push(`dispose:${sessionId}`);
    if (
      sessionId === "demonstration-session" &&
      options.demonstrationDisposalError
    ) {
      return Promise.reject(options.demonstrationDisposalError);
    }
    if (sessionId === analysisSessionId && options.analysisDisposalError) {
      return Promise.reject(options.analysisDisposalError);
    }
    return Promise.resolve();
  });
  const sessions: AgentSessions = {
    checkCompatibility: vi.fn<AgentSessions["checkCompatibility"]>(() =>
      Promise.resolve(),
    ),
    start: vi.fn<AgentSessions["start"]>(() => Promise.resolve()),
    createSession,
    runInteractive: vi.fn<AgentSessions["runInteractive"]>(() =>
      Promise.resolve({ reason: "normal" }),
    ),
    runTurn,
    readConversation: vi.fn<AgentSessions["readConversation"]>(() =>
      Promise.resolve({ turns: [] }),
    ),
    disposeSession,
    stop: vi.fn<AgentSessions["stop"]>(() => Promise.resolve()),
  };
  const writeSkillContext = vi.fn<SkillCaptureStore["writeSkillContext"]>(
    () => {
      events.push("write-skill-context");
      return options.writeSkillContextError
        ? Promise.reject(options.writeSkillContextError)
        : Promise.resolve(contextArtifact);
    },
  );
  const removeArtifact = vi.fn<SkillCaptureStore["removeArtifact"]>(() => {
    events.push("remove-demonstration-artifact");
    return options.removeArtifactError
      ? Promise.reject(options.removeArtifactError)
      : Promise.resolve();
  });
  const store: SkillCaptureStore = {
    cleanupAbandoned: vi.fn<SkillCaptureStore["cleanupAbandoned"]>(() =>
      Promise.resolve(),
    ),
    createWorkspace: vi.fn<SkillCaptureStore["createWorkspace"]>(() =>
      Promise.resolve(workspace),
    ),
    writeDemonstration: vi.fn<SkillCaptureStore["writeDemonstration"]>(() =>
      Promise.resolve(demonstrationArtifact),
    ),
    writeSkillContext,
    removeArtifact,
    cleanup: vi.fn<SkillCaptureStore["cleanup"]>(() => Promise.resolve()),
  };
  const request: AnalyzeDemonstrationRequest = {
    currentDirectory: "/project",
    workspace,
    demonstrationSessionId: "demonstration-session",
    demonstrationArtifact,
  };

  return {
    createSession,
    disposeSession,
    events,
    removeArtifact,
    request,
    runTurn,
    stage: new AnalyzeDemonstration(sessions, store),
    writeSkillContext,
  };
}

describe("AnalyzeDemonstration", () => {
  it("runs one isolated analysis turn and crosses the privacy boundary", async () => {
    const {
      createSession,
      disposeSession,
      events,
      removeArtifact,
      request,
      runTurn,
      stage,
      writeSkillContext,
    } = fixture();
    const signal = new AbortController().signal;

    await expect(stage.analyze({ ...request, signal })).resolves.toEqual({
      outcome: "analyzed",
      artifact: contextArtifact,
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledWith({
      currentDirectory: "/project",
      retention: "managed",
    });
    expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn).toHaveBeenCalledWith("analysis-session", {
      prompt: buildAnalysisPrompt(demonstrationArtifact.agentReference),
      filesystem: "read-only",
      network: false,
      expectedResult: "markdown",
      readableResources: [demonstrationArtifact.agentReference],
      signal,
    });
    expect(writeSkillContext).toHaveBeenCalledOnce();
    expect(writeSkillContext).toHaveBeenCalledWith(workspace, markdown);
    expect(removeArtifact).toHaveBeenCalledOnce();
    expect(removeArtifact).toHaveBeenCalledWith(demonstrationArtifact);
    expect(disposeSession).toHaveBeenCalledTimes(2);
    expect(disposeSession).toHaveBeenCalledWith("demonstration-session");
    expect(disposeSession).toHaveBeenCalledWith("analysis-session");
    expect(events.indexOf("write-skill-context")).toBeLessThan(
      events.indexOf("remove-demonstration-artifact"),
    );
  });

  it("persists valid Markdown without normalizing it", async () => {
    const { request, stage, writeSkillContext } = fixture({
      turnResult: { status: "completed", content: markdown },
    });

    await stage.analyze(request);

    expect(writeSkillContext).toHaveBeenCalledWith(workspace, markdown);
  });

  it("returns cancellation for an interrupted turn after disposing only the analysis session", async () => {
    const {
      disposeSession,
      removeArtifact,
      request,
      stage,
      writeSkillContext,
    } = fixture({ turnResult: { status: "interrupted" } });

    await expect(stage.analyze(request)).resolves.toEqual({
      outcome: "canceled",
    });

    expect(writeSkillContext).not.toHaveBeenCalled();
    expect(removeArtifact).not.toHaveBeenCalled();
    expect(disposeSession).toHaveBeenCalledOnce();
    expect(disposeSession).toHaveBeenCalledWith("analysis-session");
  });

  it.each<AgentTurnResult>([
    { status: "failed" },
    { status: "completed" },
    { status: "completed", content: "" },
    { status: "completed", content: " \n\t" },
  ])("rejects unusable analysis output: %j", async (turnResult) => {
    const {
      disposeSession,
      removeArtifact,
      request,
      stage,
      writeSkillContext,
    } = fixture({ turnResult });

    await expect(stage.analyze(request)).rejects.toMatchObject({
      code:
        turnResult.status === "failed" ? "analysis_failed" : "invalid_analysis",
      stage: "analysis",
    });

    expect(writeSkillContext).not.toHaveBeenCalled();
    expect(removeArtifact).not.toHaveBeenCalled();
    expect(disposeSession).toHaveBeenCalledOnce();
    expect(disposeSession).toHaveBeenCalledWith("analysis-session");
  });

  it.each([
    ["session creation", { createSessionError: new Error("create failed") }],
    ["turn execution", { runTurnError: new Error("turn failed") }],
    [
      "context persistence",
      { writeSkillContextError: new Error("write failed") },
    ],
  ] as const)(
    "surfaces %s failure as analysis_failed",
    async (_label, options) => {
      const { disposeSession, removeArtifact, request, stage } =
        fixture(options);

      await expect(stage.analyze(request)).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(CreateSkillError);
          expect(error).toMatchObject({
            code: "analysis_failed",
            stage: "analysis",
          });
          return true;
        },
      );

      expect(removeArtifact).not.toHaveBeenCalled();
      expect(disposeSession).toHaveBeenCalledTimes(
        "createSessionError" in options ? 0 : 1,
      );
    },
  );

  it("rejects a non-isolated analysis session without deleting the demonstration", async () => {
    const {
      disposeSession,
      removeArtifact,
      request,
      runTurn,
      stage,
      writeSkillContext,
    } = fixture({ analysisSessionId: "demonstration-session" });

    await expect(stage.analyze(request)).rejects.toMatchObject({
      code: "analysis_failed",
      stage: "analysis",
    });

    expect(runTurn).not.toHaveBeenCalled();
    expect(writeSkillContext).not.toHaveBeenCalled();
    expect(removeArtifact).not.toHaveBeenCalled();
    expect(disposeSession).not.toHaveBeenCalled();
  });

  it.each([
    ["raw artifact", { removeArtifactError: new Error("remove failed") }],
    [
      "demonstration session",
      { demonstrationDisposalError: new Error("demo dispose failed") },
    ],
    [
      "analysis session",
      { analysisDisposalError: new Error("analysis dispose failed") },
    ],
  ] as const)(
    "surfaces incomplete %s cleanup after attempting every privacy action",
    async (_label, options) => {
      const {
        disposeSession,
        removeArtifact,
        request,
        stage,
        writeSkillContext,
      } = fixture(options);

      await expect(stage.analyze(request)).rejects.toMatchObject({
        code: "cleanup_failed",
        stage: "cleanup",
      });

      expect(writeSkillContext).toHaveBeenCalledOnce();
      expect(removeArtifact).toHaveBeenCalledOnce();
      expect(disposeSession).toHaveBeenCalledWith("demonstration-session");
      expect(disposeSession).toHaveBeenCalledWith("analysis-session");
    },
  );

  it("keeps the primary analysis error when analysis-session disposal also fails", async () => {
    const primaryCause = new Error("turn failed");
    const cleanupCause = new Error("dispose failed");
    const { request, stage } = fixture({
      runTurnError: primaryCause,
      analysisDisposalError: cleanupCause,
    });

    await expect(stage.analyze(request)).rejects.toSatisfy((error: unknown) => {
      expect(error).toMatchObject({
        code: "analysis_failed",
        stage: "analysis",
      });
      expect((error as CreateSkillError).cause).toBeInstanceOf(AggregateError);
      const aggregate = (error as CreateSkillError).cause as AggregateError;
      expect(aggregate.errors).toContain(primaryCause);
      expect(aggregate.errors).toContain(cleanupCause);
      return true;
    });
  });
});
