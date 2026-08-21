import type {
  AgentConversation,
  AgentConversationItem,
} from "../../../ports/agent-sessions.js";

const NOT_PROVIDED = "_Not provided._";

export function serializeAgentConversation(
  workflowDescription: string,
  conversation: AgentConversation,
): string {
  const sections = [
    "# Workflow Demonstration",
    renderField("## Declared workflow", workflowDescription),
  ];

  conversation.turns.forEach((turn, turnIndex) => {
    sections.push(`## Turn ${turnIndex + 1}`);
    sections.push(renderField("### Turn ID", turn.id));

    turn.items.forEach((item, itemIndex) => {
      sections.push(renderItem(item, itemIndex));
    });
  });

  return `${sections.join("\n\n")}\n`;
}

function renderItem(item: AgentConversationItem, itemIndex: number): string {
  const ordinal = itemIndex + 1;

  switch (item.type) {
    case "user_message":
      return renderItemSection(ordinal, "User input", item.id, [
        renderField("#### Content", item.content),
      ]);
    case "agent_message":
      return renderItemSection(ordinal, "Agent response", item.id, [
        renderField("#### Content", item.content),
      ]);
    case "command_execution":
      return renderItemSection(ordinal, "Command execution", item.id, [
        renderField("#### Command", item.command),
      ]);
    case "command_result":
      return renderItemSection(ordinal, "Command result", item.id, [
        renderField("#### Command ID", item.commandId),
        renderOptionalField("#### Exit code", item.exitCode, String),
        renderOptionalField("#### Content", item.content),
      ]);
    case "tool_call":
      return renderItemSection(ordinal, "Tool call", item.id, [
        renderField("#### Tool name", item.name),
        renderOptionalField("#### Arguments", item.arguments),
      ]);
    case "tool_result":
      return renderItemSection(ordinal, "Tool result", item.id, [
        renderField("#### Call ID", item.callId),
        renderOptionalField("#### Error", item.isError, String),
        renderOptionalField("#### Content", item.content),
      ]);
    case "file_change":
      return renderItemSection(ordinal, "File change", item.id, [
        renderField("#### Path", item.path),
        renderField("#### Change", item.change),
        renderOptionalField("#### Patch", item.patch),
      ]);
    case "other":
      return renderItemSection(ordinal, "Other observable item", item.id, [
        renderField("#### Label", item.label),
        renderOptionalField("#### Content", item.content),
      ]);
  }
}

function renderItemSection(
  ordinal: number,
  label: string,
  id: string,
  fields: readonly string[],
): string {
  return [
    `### Item ${ordinal}: ${label}`,
    renderField("#### Item ID", id),
    ...fields,
  ].join("\n\n");
}

function renderField(heading: string, value: string): string {
  return `${heading}\n\n${renderFence(value)}`;
}

function renderOptionalField<T extends string | number | boolean>(
  heading: string,
  value: T | undefined,
  format: (value: T) => string = String,
): string {
  if (value === undefined) {
    return `${heading}\n\n${NOT_PROVIDED}`;
  }

  return renderField(heading, format(value));
}

function renderFence(content: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));

  return `${fence}text\n${content}\n${fence}`;
}
