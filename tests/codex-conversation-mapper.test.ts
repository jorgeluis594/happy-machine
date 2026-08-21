import { describe, expect, it } from "vitest";
import {
  CodexConversationProtocolError,
  mapCodexConversation,
} from "../src/infrastructure/outbound/agent-sessions/codex-app-server/codex-conversation-mapper.js";

describe("mapCodexConversation", () => {
  it("maps representative observable Codex items in turn and item order", () => {
    const conversation = mapCodexConversation({
      id: "thread-1",
      vendorThreadField: "does not cross the boundary",
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [
                { type: "text", text: "Inspect the project" },
                { type: "mention", name: "README", path: "README.md" },
              ],
            },
            { id: "agent-1", type: "agentMessage", text: "I will inspect it" },
            {
              id: "command-1",
              type: "commandExecution",
              command: "npm test",
              status: "completed",
              aggregatedOutput: "Tests passed",
              exitCode: 0,
            },
          ],
        },
        {
          id: "turn-2",
          items: [
            {
              id: "tool-1",
              type: "mcpToolCall",
              server: "filesystem",
              tool: "read_file",
              arguments: { path: "README.md", encoding: "utf8" },
              status: "completed",
              result: {
                content: [
                  { type: "text", text: "# Project" },
                  { type: "image", data: "raw-image-data" },
                ],
                structuredContent: { privateVendorShape: true },
              },
              error: null,
            },
            {
              id: "tool-2",
              type: "dynamicToolCall",
              namespace: "tickets",
              tool: "lookup",
              arguments: { id: "ABC-123" },
              status: "failed",
              success: false,
              contentItems: [{ type: "inputText", text: "Ticket missing" }],
            },
            {
              id: "files-1",
              type: "fileChange",
              status: "completed",
              changes: [
                { path: "new.ts", kind: { type: "add" }, diff: "+new" },
                {
                  path: "old.ts",
                  kind: { type: "update", move_path: null },
                  diff: "-old\n+new",
                },
                { path: "gone.ts", kind: { type: "delete" }, diff: "-gone" },
              ],
            },
          ],
        },
      ],
    });

    expect(conversation).toEqual({
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "user-1",
              type: "user_message",
              content: "Inspect the project\n[Mention: README: README.md]",
            },
            {
              id: "agent-1",
              type: "agent_message",
              content: "I will inspect it",
            },
            { id: "command-1", type: "command_execution", command: "npm test" },
            {
              id: "command-1:result",
              type: "command_result",
              commandId: "command-1",
              content: "Tests passed",
              exitCode: 0,
            },
          ],
        },
        {
          id: "turn-2",
          items: [
            {
              id: "tool-1",
              type: "tool_call",
              name: "filesystem.read_file",
              arguments: '{"encoding":"utf8","path":"README.md"}',
            },
            {
              id: "tool-1:result",
              type: "tool_result",
              callId: "tool-1",
              content: "# Project\n[image]",
              isError: false,
            },
            {
              id: "tool-2",
              type: "tool_call",
              name: "tickets.lookup",
              arguments: '{"id":"ABC-123"}',
            },
            {
              id: "tool-2:result",
              type: "tool_result",
              callId: "tool-2",
              content: "Ticket missing",
              isError: true,
            },
            {
              id: "files-1:change:1",
              type: "file_change",
              path: "new.ts",
              change: "created",
              patch: "+new",
            },
            {
              id: "files-1:change:2",
              type: "file_change",
              path: "old.ts",
              change: "updated",
              patch: "-old\n+new",
            },
            {
              id: "files-1:change:3",
              type: "file_change",
              path: "gone.ts",
              change: "deleted",
              patch: "-gone",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(conversation)).not.toContain("vendorThreadField");
    expect(JSON.stringify(conversation)).not.toContain("privateVendorShape");
    expect(JSON.stringify(conversation)).not.toContain("raw-image-data");
  });

  it("maps unsupported variants to sanitized other items without raw DTO data", () => {
    const rawUnknown = {
      id: "future-1",
      type: "futureVendorEvent",
      text: "Observable summary",
      query: "safe query",
      status: "completed",
      secretNestedPayload: {
        token: "must-not-cross",
        proprietary: [1, 2, 3],
      },
      content: [{ raw: "vendor DTO" }],
    };

    const conversation = mapCodexConversation({
      id: "thread-1",
      turns: [{ id: "turn-1", items: [rawUnknown] }],
    });

    expect(conversation.turns[0]?.items).toEqual([
      {
        id: "future-1",
        type: "other",
        label: "Codex futureVendorEvent",
        content:
          "Text: Observable summary\nQuery: safe query\nStatus: completed",
      },
    ]);
    expect(conversation.turns[0]?.items[0]).not.toBe(rawUnknown);
    expect(JSON.stringify(conversation)).not.toContain("must-not-cross");
    expect(JSON.stringify(conversation)).not.toContain("secretNestedPayload");
    expect(JSON.stringify(conversation)).not.toContain("vendor DTO");
  });

  it("maps unsupported file-change kinds to other without losing chronology", () => {
    const conversation = mapCodexConversation({
      id: "thread-1",
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "files-1",
              type: "fileChange",
              status: "completed",
              changes: [
                { path: "a.ts", kind: { type: "update" }, diff: "+a" },
                { path: "b.ts", kind: { type: "copy" }, diff: "+b" },
                { path: "c.ts", kind: { type: "delete" }, diff: "-c" },
              ],
            },
          ],
        },
      ],
    });

    expect(conversation.turns[0]?.items.map((item) => item.type)).toEqual([
      "file_change",
      "other",
      "file_change",
    ]);
    expect(conversation.turns[0]?.items[1]).toEqual({
      id: "files-1:change:2",
      type: "other",
      label: "Codex fileChange (copy)",
      content: "Path: b.ts",
    });
  });

  it.each([
    {
      name: "thread identity",
      value: { turns: [] },
      path: "thread.id",
    },
    {
      name: "turn chronology",
      value: { id: "thread-1" },
      path: "thread.turns",
    },
    {
      name: "turn identity",
      value: { id: "thread-1", turns: [{ items: [] }] },
      path: "thread.turns[0].id",
    },
    {
      name: "item chronology",
      value: { id: "thread-1", turns: [{ id: "turn-1" }] },
      path: "thread.turns[0].items",
    },
    {
      name: "item identity",
      value: {
        id: "thread-1",
        turns: [{ id: "turn-1", items: [{ type: "future" }] }],
      },
      path: "thread.turns[0].items[0].id",
    },
    {
      name: "item variant identity",
      value: {
        id: "thread-1",
        turns: [{ id: "turn-1", items: [{ id: "item-1" }] }],
      },
      path: "thread.turns[0].items[0].type",
    },
  ])(
    "rejects malformed $name with an adapter protocol error",
    ({ value, path }) => {
      expect(() => mapCodexConversation(value)).toThrowError(
        expect.objectContaining({
          name: "CodexConversationProtocolError",
          code: "protocol_error",
          path,
        }),
      );
    },
  );

  it("rejects duplicate identity that would make chronology ambiguous", () => {
    expect(() =>
      mapCodexConversation({
        id: "thread-1",
        turns: [
          {
            id: "turn-1",
            items: [
              { id: "same", type: "agentMessage", text: "first" },
              { id: "same", type: "agentMessage", text: "second" },
            ],
          },
        ],
      }),
    ).toThrowError(CodexConversationProtocolError);
  });

  it("is deterministic and does not mutate the vendor DTO", () => {
    const dto = {
      id: "thread-1",
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "tool-1",
              type: "dynamicToolCall",
              tool: "lookup",
              namespace: null,
              arguments: { z: 1, nested: { b: 2, a: 1 }, a: 2 },
              status: "completed",
              success: true,
              contentItems: null,
            },
          ],
        },
      ],
    };
    const before = structuredClone(dto);

    const first = mapCodexConversation(dto);
    const second = mapCodexConversation(dto);

    expect(first).toEqual(second);
    expect(dto).toEqual(before);
    expect(first.turns[0]?.items[0]).toMatchObject({
      arguments: '{"a":2,"nested":{"a":1,"b":2},"z":1}',
    });
  });
});
