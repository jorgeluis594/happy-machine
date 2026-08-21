import { describe, expect, it, vi } from "vitest";
import {
  CaptureDemonstration,
  type CaptureDemonstrationRequest,
} from "../src/application/use-cases/create-skill/capture-demonstration.js";
import { CreateSkillError } from "../src/application/use-cases/create-skill/create-skill-errors.js";
import { serializeAgentConversation } from "../src/application/use-cases/create-skill/serialize-agent-conversation.js";
import type {
  AgentConversation,
  AgentSessions,
  InteractiveExit,
} from "../src/ports/agent-sessions.js";
import type {
  CaptureArtifact,
  CaptureWorkspace,
  SkillCaptureStore,
} from "../src/ports/skill-capture-store.js";

const workspace: CaptureWorkspace = { id: "workspace-1" };
const artifact: CaptureArtifact = {
  id: "artifact-1",
  agentReference: "artifact://capture/demonstration.md",
};
const conversation: AgentConversation = {
  turns: [
    {
      id: "turn-1",
      items: [
        {
          id: "message-1",
          type: "user_message",
          content: "Investigate the failure",
        },
        {
          id: "message-2",
          type: "agent_message",
          content: "The focused test now passes",
        },
      ],
    },
  ],
};
const failureCauses = {
  createSession: new Error("create failed"),
  runInteractive: new Error("TUI failed to launch"),
  readConversation: new Error("thread/read failed"),
  writeDemonstration: new Error("write failed"),
};

function fixture(
  options: {
    interactiveExit?: InteractiveExit;
    capturedConversation?: AgentConversation;
    createSessionError?: Error;
    runInteractiveError?: Error;
    readConversationError?: Error;
    writeDemonstrationError?: Error;
  } = {},
) {
  const createSession = vi.fn<AgentSessions["createSession"]>(() =>
    options.createSessionError
      ? Promise.reject(options.createSessionError)
      : Promise.resolve("demonstration-session"),
  );
  const runInteractive = vi.fn<AgentSessions["runInteractive"]>(() =>
    options.runInteractiveError
      ? Promise.reject(options.runInteractiveError)
      : Promise.resolve(
          options.interactiveExit ?? { reason: "normal", exitCode: 0 },
        ),
  );
  const readConversation = vi.fn<AgentSessions["readConversation"]>(() =>
    options.readConversationError
      ? Promise.reject(options.readConversationError)
      : Promise.resolve(options.capturedConversation ?? conversation),
  );
  const sessions: AgentSessions = {
    checkCompatibility: vi.fn<AgentSessions["checkCompatibility"]>(() =>
      Promise.resolve(),
    ),
    start: vi.fn<AgentSessions["start"]>(() => Promise.resolve()),
    createSession,
    runInteractive,
    runTurn: vi.fn<AgentSessions["runTurn"]>(() =>
      Promise.resolve({ status: "completed" }),
    ),
    readConversation,
    disposeSession: vi.fn<AgentSessions["disposeSession"]>(() =>
      Promise.resolve(),
    ),
    stop: vi.fn<AgentSessions["stop"]>(() => Promise.resolve()),
  };
  const writeDemonstration = vi.fn<SkillCaptureStore["writeDemonstration"]>(
    () =>
      options.writeDemonstrationError
        ? Promise.reject(options.writeDemonstrationError)
        : Promise.resolve(artifact),
  );
  const store: SkillCaptureStore = {
    cleanupAbandoned: vi.fn<SkillCaptureStore["cleanupAbandoned"]>(() =>
      Promise.resolve(),
    ),
    createWorkspace: vi.fn<SkillCaptureStore["createWorkspace"]>(() =>
      Promise.resolve(workspace),
    ),
    writeDemonstration,
    writeSkillContext: vi.fn<SkillCaptureStore["writeSkillContext"]>(() =>
      Promise.resolve(artifact),
    ),
    removeArtifact: vi.fn<SkillCaptureStore["removeArtifact"]>(() =>
      Promise.resolve(),
    ),
    cleanup: vi.fn<SkillCaptureStore["cleanup"]>(() => Promise.resolve()),
  };
  const stage = new CaptureDemonstration(sessions, store);
  const request: CaptureDemonstrationRequest = {
    currentDirectory: "/project",
    workflowDescription: "Investigate and fix a failing test",
    workspace,
  };

  return {
    createSession,
    readConversation,
    request,
    runInteractive,
    stage,
    writeDemonstration,
  };
}

describe("CaptureDemonstration", () => {
  it.each<InteractiveExit>([
    { reason: "normal" },
    { reason: "normal", exitCode: 0 },
  ])(
    "captures the complete conversation after a normal exit: %j",
    async (interactiveExit) => {
      const {
        createSession,
        readConversation,
        request,
        runInteractive,
        stage,
        writeDemonstration,
      } = fixture({ interactiveExit });
      const signal = new AbortController().signal;

      await expect(stage.capture({ ...request, signal })).resolves.toEqual({
        outcome: "captured",
        sessionId: "demonstration-session",
        artifact,
      });

      expect(createSession).toHaveBeenCalledOnce();
      expect(createSession).toHaveBeenCalledWith({
        currentDirectory: "/project",
        retention: "managed",
      });
      expect(runInteractive).toHaveBeenCalledOnce();
      expect(runInteractive).toHaveBeenCalledWith("demonstration-session", {
        signal,
      });
      expect(runInteractive.mock.calls[0]?.[1]).not.toHaveProperty(
        "initialPrompt",
      );
      expect(readConversation).toHaveBeenCalledOnce();
      expect(readConversation).toHaveBeenCalledWith("demonstration-session");
      expect(writeDemonstration).toHaveBeenCalledOnce();
      expect(writeDemonstration).toHaveBeenCalledWith(
        workspace,
        serializeAgentConversation(request.workflowDescription, conversation),
      );
    },
  );

  it("returns cancellation after an interrupted TUI and forwards the abort signal", async () => {
    const {
      readConversation,
      request,
      runInteractive,
      stage,
      writeDemonstration,
    } = fixture({
      interactiveExit: { reason: "interrupted" },
    });
    const signal = new AbortController().signal;

    await expect(stage.capture({ ...request, signal })).resolves.toEqual({
      outcome: "canceled",
      sessionId: "demonstration-session",
    });

    expect(runInteractive).toHaveBeenCalledWith("demonstration-session", {
      signal,
    });
    expect(readConversation).not.toHaveBeenCalled();
    expect(writeDemonstration).not.toHaveBeenCalled();
  });

  it.each<InteractiveExit>([
    { reason: "failed" },
    { reason: "failed", exitCode: 9 },
    { reason: "normal", exitCode: 3 },
  ])("rejects an unsuccessful TUI exit: %j", async (interactiveExit) => {
    const { readConversation, request, stage, writeDemonstration } = fixture({
      interactiveExit,
    });

    await expect(stage.capture(request)).rejects.toMatchObject({
      code: "demonstration_failed",
      stage: "demonstration",
    });

    expect(readConversation).not.toHaveBeenCalled();
    expect(writeDemonstration).not.toHaveBeenCalled();
  });

  it.each<AgentConversation>([
    { turns: [] },
    { turns: [{ id: "empty-turn", items: [] }] },
  ])(
    "rejects an empty observable conversation: %j",
    async (capturedConversation) => {
      const { request, stage, writeDemonstration } = fixture({
        capturedConversation,
      });

      await expect(stage.capture(request)).rejects.toMatchObject({
        code: "demonstration_empty",
        stage: "demonstration",
      });

      expect(writeDemonstration).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "session creation",
      { createSessionError: failureCauses.createSession },
      failureCauses.createSession,
    ],
    [
      "launch",
      { runInteractiveError: failureCauses.runInteractive },
      failureCauses.runInteractive,
    ],
    [
      "read",
      { readConversationError: failureCauses.readConversation },
      failureCauses.readConversation,
    ],
    [
      "persist",
      { writeDemonstrationError: failureCauses.writeDemonstration },
      failureCauses.writeDemonstration,
    ],
  ] as const)(
    "preserves the cause of a %s failure behind the stable error",
    async (_operation, options, cause) => {
      const { request, stage } = fixture(options);

      await expect(stage.capture(request)).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(CreateSkillError);
          expect(error).toMatchObject({
            code: "demonstration_failed",
            stage: "demonstration",
            cause,
          });
          return true;
        },
      );
    },
  );
});
