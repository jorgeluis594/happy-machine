import { describe, expect, it } from "vitest";
import { serializeAgentConversation } from "../src/application/use-cases/create-skill/serialize-agent-conversation.js";
import type { AgentConversation } from "../src/ports/agent-sessions.js";

describe("serializeAgentConversation", () => {
  it("serializes every observable item in turn and item chronology", () => {
    const conversation: AgentConversation = {
      turns: [
        {
          id: "turn-one",
          items: [
            { id: "user-1", type: "user_message", content: "Start here" },
            {
              id: "agent-1",
              type: "agent_message",
              content: "I will inspect the project",
            },
            {
              id: "command-1",
              type: "command_execution",
              command: "npm test",
            },
            {
              id: "command-result-1",
              type: "command_result",
              commandId: "command-1",
              content: "Tests passed",
              exitCode: 0,
            },
          ],
        },
        {
          id: "turn-two",
          items: [
            {
              id: "tool-1",
              type: "tool_call",
              name: "read_file",
              arguments: '{"path":"README.md"}',
            },
            {
              id: "tool-result-1",
              type: "tool_result",
              callId: "tool-1",
              content: "# Project",
              isError: false,
            },
            {
              id: "file-1",
              type: "file_change",
              path: "README.md",
              change: "updated",
              patch: "+Documented",
            },
            {
              id: "other-1",
              type: "other",
              label: "Plan update",
              content: "Implementation is complete",
            },
          ],
        },
      ],
    };

    const markdown = serializeAgentConversation(
      "Investigate and fix the project",
      conversation,
    );

    expect(markdown).toContain("# Workflow Demonstration");
    expect(markdown).toContain("## Declared workflow");
    expect(markdown).toContain("Investigate and fix the project");

    const chronologicalMarkers = [
      "## Turn 1",
      "### Item 1: User input",
      "Start here",
      "### Item 2: Agent response",
      "I will inspect the project",
      "### Item 3: Command execution",
      "npm test",
      "### Item 4: Command result",
      "command-1",
      "Tests passed",
      "## Turn 2",
      "### Item 1: Tool call",
      "read_file",
      "### Item 2: Tool result",
      "tool-1",
      "# Project",
      "### Item 3: File change",
      "README.md",
      "updated",
      "+Documented",
      "### Item 4: Other observable item",
      "Plan update",
      "Implementation is complete",
    ];

    let priorIndex = -1;
    for (const marker of chronologicalMarkers) {
      const index = markdown.indexOf(marker, priorIndex + 1);
      expect(
        index,
        `expected ${JSON.stringify(marker)} in order`,
      ).toBeGreaterThan(priorIndex);
      priorIndex = index;
    }

    expect(markdown).toContain("#### Exit code\n\n```text\n0\n```");
    expect(markdown).toContain("#### Error\n\n```text\nfalse\n```");
  });

  it("uses fences longer than malicious backticks and ignores tildes", () => {
    const maliciousContent = [
      "before",
      "```",
      "`````text",
      "# injected heading",
      "~~~~~~",
      "after",
    ].join("\n");
    const conversation: AgentConversation = {
      turns: [
        {
          id: "turn-```-~~~~",
          items: [
            {
              id: "message-1",
              type: "user_message",
              content: maliciousContent,
            },
          ],
        },
      ],
    };

    const markdown = serializeAgentConversation(
      "workflow with ```` and ~~~~~ fences",
      conversation,
    );

    expect(markdown).toContain(
      "`````text\nworkflow with ```` and ~~~~~ fences\n`````",
    );
    expect(markdown).toContain(
      `\`\`\`\`\`\`text\n${maliciousContent}\n\`\`\`\`\`\``,
    );
    expect(markdown).not.toContain(
      "### Turn ID\n\n```text\nturn-```-~~~~\n```",
    );
  });

  it("distinguishes missing optional values from present empty content", () => {
    const conversation: AgentConversation = {
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "command-result-1",
              type: "command_result",
              commandId: "command-1",
              content: "",
            },
            {
              id: "tool-1",
              type: "tool_call",
              name: "inspect",
            },
            {
              id: "tool-result-1",
              type: "tool_result",
              callId: "tool-1",
            },
            {
              id: "file-1",
              type: "file_change",
              path: "empty.txt",
              change: "created",
            },
            {
              id: "other-1",
              type: "other",
              label: "Unsupported",
            },
          ],
        },
      ],
    };

    const markdown = serializeAgentConversation("", conversation);

    expect(markdown).toContain("## Declared workflow\n\n```text\n\n```");
    expect(markdown).toContain("#### Content\n\n```text\n\n```");
    expect(markdown.match(/_Not provided\._/g)).toHaveLength(6);
  });

  it("serializes only neutral fields from an other item", () => {
    const conversation = {
      turns: [
        {
          id: "turn-1",
          items: [
            {
              id: "other-1",
              type: "other",
              label: "Unknown event",
              content: "Observable summary",
              vendorPayload: "secret raw DTO",
            },
          ],
        },
      ],
    } as unknown as AgentConversation;

    const markdown = serializeAgentConversation("Workflow", conversation);

    expect(markdown).toContain("Unknown event");
    expect(markdown).toContain("Observable summary");
    expect(markdown).not.toContain("secret raw DTO");
    expect(markdown).not.toContain("vendorPayload");
  });
});
