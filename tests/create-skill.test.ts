import { describe, expect, it, vi } from "vitest";
import {
  CreateSkill,
  type AnalyzeDemonstrationStage,
  type CaptureDemonstrationStage,
  type CreateSkillRequest,
  type LaunchSkillGenerationStage,
} from "../src/application/use-cases/create-skill/create-skill.js";
import { CreateSkillError } from "../src/application/use-cases/create-skill/create-skill-errors.js";
import {
  AgentRuntimeIncompatibleError,
  AgentRuntimeUnavailableError,
  type AgentSessions,
} from "../src/ports/agent-sessions.js";
import {
  ExclusiveOperationAlreadyActiveError,
  type ExclusiveOperationLock,
} from "../src/ports/exclusive-operation-lock.js";
import {
  SkillCaptureCleanupError,
  type SkillCaptureStore,
} from "../src/ports/skill-capture-store.js";

const lease = { id: "lease-1" };
const workspace = { id: "workspace-1" };
const demonstrationArtifact = {
  id: "demonstration-artifact",
  agentReference: "artifact://capture/demonstration.md",
};
const contextArtifact = {
  id: "context-artifact",
  agentReference: "artifact://capture/skill-context.md",
};

interface FixtureOptions {
  acquireError?: Error;
  compatibilityError?: Error;
  consent?: boolean;
  consentError?: Error;
  abandonedCleanupError?: Error;
  workspaceError?: Error;
  startError?: Error;
  captureResult?: Awaited<ReturnType<CaptureDemonstrationStage["capture"]>>;
  captureError?: Error;
  analysisResult?: Awaited<ReturnType<AnalyzeDemonstrationStage["analyze"]>>;
  analysisError?: Error;
  launchResult?: Awaited<ReturnType<LaunchSkillGenerationStage["launch"]>>;
  launchError?: Error;
  disposalError?: Error;
  stopError?: Error;
  cleanupError?: Error;
  releaseError?: Error;
}

function fixture(options: FixtureOptions = {}) {
  const events: string[] = [];
  const call = <T>(event: string, value: T, error?: Error): Promise<T> => {
    events.push(event);
    return error === undefined ? Promise.resolve(value) : Promise.reject(error);
  };

  const lock: ExclusiveOperationLock = {
    acquire: vi.fn<ExclusiveOperationLock["acquire"]>(() =>
      call("acquire", lease, options.acquireError),
    ),
    release: vi.fn<ExclusiveOperationLock["release"]>(() =>
      call("release", undefined, options.releaseError),
    ),
  };
  const checkCompatibility = vi.fn<AgentSessions["checkCompatibility"]>(() =>
    call("check-compatibility", undefined, options.compatibilityError),
  );
  const start = vi.fn<AgentSessions["start"]>(() =>
    call("start-runtime", undefined, options.startError),
  );
  const disposeSession = vi.fn<AgentSessions["disposeSession"]>((sessionId) =>
    call(`dispose:${sessionId}`, undefined, options.disposalError),
  );
  const stop = vi.fn<AgentSessions["stop"]>(() =>
    call("stop-runtime", undefined, options.stopError),
  );
  const sessions: AgentSessions = {
    checkCompatibility,
    start,
    createSession: vi.fn<AgentSessions["createSession"]>(() =>
      Promise.reject(new Error("A stage fake owns session creation.")),
    ),
    runInteractive: vi.fn<AgentSessions["runInteractive"]>(() =>
      Promise.reject(new Error("A stage fake owns TUI execution.")),
    ),
    runTurn: vi.fn<AgentSessions["runTurn"]>(() =>
      Promise.reject(new Error("A stage fake owns turn execution.")),
    ),
    readConversation: vi.fn<AgentSessions["readConversation"]>(() =>
      Promise.reject(new Error("A stage fake owns conversation reading.")),
    ),
    disposeSession,
    stop,
  };
  const cleanupAbandoned = vi.fn<SkillCaptureStore["cleanupAbandoned"]>(() =>
    call("cleanup-abandoned", undefined, options.abandonedCleanupError),
  );
  const createWorkspace = vi.fn<SkillCaptureStore["createWorkspace"]>(() =>
    call("create-workspace", workspace, options.workspaceError),
  );
  const cleanupWorkspace = vi.fn<SkillCaptureStore["cleanup"]>(() =>
    call("cleanup-workspace", undefined, options.cleanupError),
  );
  const store: SkillCaptureStore = {
    cleanupAbandoned,
    createWorkspace,
    writeDemonstration: vi.fn<SkillCaptureStore["writeDemonstration"]>(() =>
      Promise.reject(new Error("A stage fake owns demonstration writes.")),
    ),
    writeSkillContext: vi.fn<SkillCaptureStore["writeSkillContext"]>(() =>
      Promise.reject(new Error("A stage fake owns context writes.")),
    ),
    removeArtifact: vi.fn<SkillCaptureStore["removeArtifact"]>(() =>
      Promise.reject(new Error("A stage fake owns early artifact removal.")),
    ),
    cleanup: cleanupWorkspace,
  };
  const captureCall = vi.fn<CaptureDemonstrationStage["capture"]>(() =>
    call(
      "capture-demonstration",
      options.captureResult ?? {
        outcome: "captured",
        sessionId: "demonstration-session",
        artifact: demonstrationArtifact,
      },
      options.captureError,
    ),
  );
  const capture: CaptureDemonstrationStage = {
    capture: captureCall,
  };
  const analyzeCall = vi.fn<AnalyzeDemonstrationStage["analyze"]>(() =>
    call(
      "analyze-demonstration",
      options.analysisResult ?? {
        outcome: "analyzed",
        sessionId: "analysis-session",
        artifact: contextArtifact,
      },
      options.analysisError,
    ),
  );
  const analyze: AnalyzeDemonstrationStage = {
    analyze: analyzeCall,
  };
  const launchCall = vi.fn<LaunchSkillGenerationStage["launch"]>(() =>
    call(
      "launch-generation",
      options.launchResult ?? {
        outcome: "completed",
        sessionId: "generation-session",
      },
      options.launchError,
    ),
  );
  const launch: LaunchSkillGenerationStage = {
    launch: launchCall,
  };
  const confirmRecording = vi.fn<CreateSkillRequest["confirmRecording"]>(() =>
    call("confirm-recording", options.consent ?? true, options.consentError),
  );

  return {
    analyze,
    analyzeCall,
    capture,
    captureCall,
    cleanupAbandoned,
    cleanupWorkspace,
    confirmRecording,
    createWorkspace,
    disposeSession,
    events,
    launch,
    launchCall,
    lock,
    request: {
      workflowDescription: "Investigate and fix a production failure",
      currentDirectory: "/project",
      confirmRecording,
    } satisfies CreateSkillRequest,
    sessions,
    start,
    stop,
    store,
    useCase: new CreateSkill(lock, sessions, store, capture, analyze, launch),
  };
}

describe("CreateSkill", () => {
  it("orchestrates the complete flow in the approved order", async () => {
    const {
      analyzeCall,
      captureCall,
      cleanupWorkspace,
      disposeSession,
      events,
      launchCall,
      request,
      useCase,
    } = fixture();
    const signal = new AbortController().signal;

    await expect(useCase.execute({ ...request, signal })).resolves.toEqual({
      outcome: "completed",
    });

    expect(events).toEqual([
      "acquire",
      "check-compatibility",
      "confirm-recording",
      "cleanup-abandoned",
      "create-workspace",
      "start-runtime",
      "capture-demonstration",
      "analyze-demonstration",
      "launch-generation",
      "stop-runtime",
      "cleanup-workspace",
      "release",
    ]);
    expect(captureCall).toHaveBeenCalledWith({
      currentDirectory: "/project",
      workflowDescription: request.workflowDescription,
      workspace,
      signal,
    });
    expect(analyzeCall).toHaveBeenCalledWith({
      currentDirectory: "/project",
      workspace,
      demonstrationSessionId: "demonstration-session",
      demonstrationArtifact,
      signal,
    });
    expect(launchCall).toHaveBeenCalledWith({
      currentDirectory: "/project",
      workflowDescription: request.workflowDescription,
      skillContextArtifact: contextArtifact,
      previousSessionIds: ["demonstration-session", "analysis-session"],
      signal,
    });
    expect(disposeSession).not.toHaveBeenCalled();
    expect(cleanupWorkspace).toHaveBeenCalledWith(workspace);
  });

  it("declines consent without creating capture data or starting a runtime", async () => {
    const {
      cleanupAbandoned,
      createWorkspace,
      events,
      request,
      start,
      stop,
      useCase,
    } = fixture({ consent: false });

    await expect(useCase.execute(request)).resolves.toEqual({
      outcome: "canceled",
      stage: "consent",
    });

    expect(events).toEqual([
      "acquire",
      "check-compatibility",
      "confirm-recording",
      "release",
    ]);
    expect(cleanupAbandoned).not.toHaveBeenCalled();
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it.each([
    [
      "unavailable",
      new AgentRuntimeUnavailableError("missing executable"),
      "agent_runtime_unavailable",
    ],
    [
      "incompatible",
      new AgentRuntimeIncompatibleError("unsupported flags"),
      "agent_runtime_incompatible",
    ],
  ] as const)(
    "maps an %s runtime before consent and releases ownership",
    async (_label, compatibilityError, code) => {
      const { confirmRecording, events, request, useCase } = fixture({
        compatibilityError,
      });

      await expect(useCase.execute(request)).rejects.toMatchObject({
        code,
        stage: "setup",
      });
      expect(confirmRecording).not.toHaveBeenCalled();
      expect(events).toEqual(["acquire", "check-compatibility", "release"]);
    },
  );

  it("preserves remaining abandoned workspace references for safe CLI reporting", async () => {
    const abandonedWorkspace = "/private/abandoned-capture";
    const { request, useCase } = fixture({
      abandonedCleanupError: new AggregateError([
        new SkillCaptureCleanupError(abandonedWorkspace),
      ]),
    });

    await expect(useCase.execute(request)).rejects.toMatchObject({
      code: "cleanup_failed",
      stage: "cleanup",
      remainingWorkspaces: [abandonedWorkspace],
    });
  });

  it("maps a live exclusive owner to the stable busy error", async () => {
    const { events, request, useCase } = fixture({
      acquireError: new ExclusiveOperationAlreadyActiveError("create-skill"),
    });

    await expect(useCase.execute(request)).rejects.toMatchObject({
      code: "capture_already_active",
      stage: "setup",
    });
    expect(events).toEqual(["acquire"]);
  });

  it.each([
    [
      "demonstration",
      { captureError: new Error("capture failed") },
      "demonstration_failed",
      ["capture-demonstration"],
    ],
    [
      "analysis",
      { analysisError: new Error("analysis failed") },
      "analysis_failed",
      ["capture-demonstration", "analyze-demonstration"],
    ],
    [
      "generation",
      { launchError: new Error("launch failed") },
      "generation_start_failed",
      ["capture-demonstration", "analyze-demonstration", "launch-generation"],
    ],
  ] as const)(
    "stops after a %s stage failure",
    async (_stage, options, code, stageEvents) => {
      const { events, request, useCase } = fixture(options);

      await expect(useCase.execute(request)).rejects.toMatchObject({ code });
      expect(
        events.filter((event) =>
          [
            "capture-demonstration",
            "analyze-demonstration",
            "launch-generation",
          ].includes(event),
        ),
      ).toEqual(stageEvents);
      expect(events.at(-1)).toBe("release");
    },
  );

  it.each([
    [
      "demonstration",
      { captureResult: { outcome: "canceled", sessionId: "demo-canceled" } },
      "demo-canceled",
    ],
    [
      "analysis",
      { analysisResult: { outcome: "canceled" } },
      "demonstration-session",
    ],
    [
      "generation",
      {
        launchResult: {
          outcome: "canceled",
          sessionId: "generation-session",
        },
      },
      undefined,
    ],
  ] as const)(
    "propagates abort cancellation from %s and cleans managed state",
    async (stage, options, expectedDisposal) => {
      const { disposeSession, events, request, useCase } = fixture(options);
      const controller = new AbortController();
      controller.abort();

      await expect(
        useCase.execute({ ...request, signal: controller.signal }),
      ).resolves.toEqual({ outcome: "canceled", stage });
      if (expectedDisposal) {
        expect(disposeSession).toHaveBeenCalledWith(expectedDisposal);
      } else {
        expect(disposeSession).not.toHaveBeenCalled();
      }
      expect(events.at(-1)).toBe("release");
    },
  );

  it("rejects reused stage identities before generation", async () => {
    const { launchCall, request, useCase } = fixture({
      analysisResult: {
        outcome: "analyzed",
        sessionId: "demonstration-session",
        artifact: contextArtifact,
      },
    });

    await expect(useCase.execute(request)).rejects.toMatchObject({
      code: "analysis_failed",
      stage: "analysis",
    });
    expect(launchCall).not.toHaveBeenCalled();
  });

  it("preserves a primary stage error and records every cleanup failure", async () => {
    const primaryCause = new Error("turn failed");
    const primary = new CreateSkillError(
      "analysis_failed",
      "analysis",
      "The analysis failed.",
      { cause: primaryCause },
    );
    const disposalError = new Error("dispose failed");
    const stopError = new Error("stop failed");
    const cleanupError = new Error("workspace cleanup failed");
    const releaseError = new Error("release failed");
    const { events, request, useCase } = fixture({
      analysisError: primary,
      disposalError,
      stopError,
      cleanupError,
      releaseError,
    });

    await expect(useCase.execute(request)).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(CreateSkillError);
        expect(error).toMatchObject({
          code: "analysis_failed",
          stage: "analysis",
          message: primary.message,
          cleanupFailures: [
            disposalError,
            stopError,
            cleanupError,
            releaseError,
          ],
          remainingWorkspaces: [workspace.id],
        });
        const cause = (error as CreateSkillError).cause;
        expect(cause).toBeInstanceOf(AggregateError);
        expect((cause as AggregateError).errors).toContain(primaryCause);
        return true;
      },
    );
    expect(events.slice(-4)).toEqual([
      "dispose:demonstration-session",
      "stop-runtime",
      "cleanup-workspace",
      "release",
    ]);
  });

  it("returns cleanup_failed when only final cleanup fails", async () => {
    const stopError = new Error("stop failed");
    const cleanupError = new Error("workspace cleanup failed");
    const releaseError = new Error("release failed");
    const { events, request, useCase } = fixture({
      stopError,
      cleanupError,
      releaseError,
    });

    await expect(useCase.execute(request)).rejects.toMatchObject({
      code: "cleanup_failed",
      stage: "cleanup",
      cleanupFailures: [stopError, cleanupError, releaseError],
      remainingWorkspaces: [workspace.id],
    });
    expect(events.slice(-3)).toEqual([
      "stop-runtime",
      "cleanup-workspace",
      "release",
    ]);
  });

  it("attempts runtime shutdown after a partial startup failure", async () => {
    const { captureCall, events, request, useCase } = fixture({
      startError: new Error("handshake failed"),
    });

    await expect(useCase.execute(request)).rejects.toMatchObject({
      code: "agent_runtime_unavailable",
      stage: "setup",
    });
    expect(events.slice(-3)).toEqual([
      "stop-runtime",
      "cleanup-workspace",
      "release",
    ]);
    expect(captureCall).not.toHaveBeenCalled();
  });

  it.each([
    ["abandoned cleanup", { abandonedCleanupError: new Error("scan failed") }],
    ["workspace creation", { workspaceError: new Error("mkdir failed") }],
  ] as const)(
    "does not start later work after %s fails",
    async (_label, options) => {
      const { captureCall, events, request, start, useCase } = fixture(options);

      await expect(useCase.execute(request)).rejects.toMatchObject({
        code: "cleanup_failed",
        stage: "cleanup",
      });
      expect(start).not.toHaveBeenCalled();
      expect(captureCall).not.toHaveBeenCalled();
      expect(events.at(-1)).toBe("release");
    },
  );
});
