import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CreateSkillError,
  createSkillErrorCodes,
  createSkillStages,
  isCreateSkillError,
  renderCreateSkillError,
  type CreateSkillErrorCode,
  type CreateSkillStage,
} from "../src/application/use-cases/create-skill/create-skill-errors.js";
import type {
  AgentConversation,
  AgentConversationItem,
  AgentSessions,
  AgentSessionRetention,
} from "../src/ports/agent-sessions.js";
import type {
  ExclusiveOperationLock,
  ExclusiveOperationName,
} from "../src/ports/exclusive-operation-lock.js";
import type { SkillCaptureStore } from "../src/ports/skill-capture-store.js";

describe("create-skill technology-independent contracts", () => {
  it("represents ordered turns and every supported neutral item", () => {
    const items = [
      { id: "item-1", type: "user_message", content: "Show the workflow" },
      { id: "item-2", type: "agent_message", content: "I will inspect it" },
      { id: "item-3", type: "command_execution", command: "npm test" },
      {
        id: "item-4",
        type: "command_result",
        commandId: "item-3",
        content: "passed",
        exitCode: 0,
      },
      {
        id: "item-5",
        type: "tool_call",
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
      {
        id: "item-6",
        type: "tool_result",
        callId: "item-5",
        content: "# Project",
      },
      {
        id: "item-7",
        type: "file_change",
        path: "README.md",
        change: "updated",
        patch: "+Documented",
      },
      {
        id: "item-8",
        type: "other",
        label: "unsupported observable item",
      },
    ] as const satisfies readonly AgentConversationItem[];
    const conversation = {
      turns: [{ id: "turn-1", items }],
    } satisfies AgentConversation;

    expect(conversation.turns[0]?.items.map((item) => item.type)).toEqual([
      "user_message",
      "agent_message",
      "command_execution",
      "command_result",
      "tool_call",
      "tool_result",
      "file_change",
      "other",
    ]);
    expect(conversation.turns[0]?.items.at(-1)).toEqual({
      id: "item-8",
      type: "other",
      label: "unsupported observable item",
    });
  });

  it("distinguishes managed sessions from persistent sessions", () => {
    expectTypeOf<AgentSessionRetention>().toEqualTypeOf<
      "managed" | "persistent"
    >();
  });

  it("exposes independently implementable capability ports", () => {
    expectTypeOf<AgentSessions>().toBeObject();
    expectTypeOf<SkillCaptureStore>().toBeObject();
    expectTypeOf<ExclusiveOperationLock>().toBeObject();
    expectTypeOf<ExclusiveOperationName>().toEqualTypeOf<"create-skill">();
  });
});

describe("CreateSkillError", () => {
  it("makes every approved stable code and stage available at runtime", () => {
    expect(createSkillErrorCodes).toEqual([
      "capture_already_active",
      "agent_runtime_unavailable",
      "agent_runtime_incompatible",
      "demonstration_failed",
      "demonstration_empty",
      "analysis_failed",
      "invalid_analysis",
      "generation_start_failed",
      "cleanup_failed",
    ] satisfies CreateSkillErrorCode[]);
    expect(createSkillStages).toEqual([
      "setup",
      "demonstration",
      "analysis",
      "generation",
      "cleanup",
    ] satisfies CreateSkillStage[]);
  });

  it("preserves its cause and supports reliable identification", () => {
    const cause = new Error("vendor diagnostic");
    const error = new CreateSkillError(
      "analysis_failed",
      "analysis",
      "The demonstration could not be analyzed.",
      { cause },
    );

    expect(error).toBeInstanceOf(Error);
    expect(isCreateSkillError(error)).toBe(true);
    expect(isCreateSkillError(cause)).toBe(false);
    expect(error.code).toBe("analysis_failed");
    expect(error.stage).toBe("analysis");
    expect(error.cause).toBe(cause);
  });

  it("renders stable application details without exposing the cause", () => {
    const secretCause = new Error("vendor payload: secret-token");
    const error = new CreateSkillError(
      "agent_runtime_incompatible",
      "setup",
      "unsafe upstream details: captured-value",
      { cause: secretCause },
    );

    expect(renderCreateSkillError(error)).toBe(
      "CreateSkillError [agent_runtime_incompatible] at setup",
    );
    expect(renderCreateSkillError(error)).not.toContain("captured-value");
    expect(renderCreateSkillError(error)).not.toContain("secret-token");
  });
});
