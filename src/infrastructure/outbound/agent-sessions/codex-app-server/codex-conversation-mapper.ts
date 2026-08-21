import type {
  AgentConversation,
  AgentConversationItem,
  AgentFileChangeKind,
} from "../../../../ports/agent-sessions.js";

type JsonRecord = Record<string, unknown>;

export class CodexConversationProtocolError extends Error {
  override readonly name = "CodexConversationProtocolError";
  readonly code = "protocol_error";

  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`Malformed Codex conversation at ${path}: ${message}`);
  }
}

export function mapCodexConversation(threadValue: unknown): AgentConversation {
  const thread = requireRecord(threadValue, "thread");
  requireIdentifier(thread.id, "thread.id");
  const turns = requireArray(thread.turns, "thread.turns");
  const turnIds = new Set<string>();
  const sourceItemIds = new Set<string>();
  const mappedItemIds = new Set<string>();

  return {
    turns: turns.map((turnValue, turnIndex) => {
      const turnPath = `thread.turns[${String(turnIndex)}]`;
      const turn = requireRecord(turnValue, turnPath);
      const turnId = requireIdentifier(turn.id, `${turnPath}.id`);
      requireUnique(turnIds, turnId, `${turnPath}.id`, "turn");
      const items = requireArray(turn.items, `${turnPath}.items`);
      const mappedItems: AgentConversationItem[] = [];

      for (const [itemIndex, itemValue] of items.entries()) {
        const itemPath = `${turnPath}.items[${String(itemIndex)}]`;
        const item = requireRecord(itemValue, itemPath);
        const itemId = requireIdentifier(item.id, `${itemPath}.id`);
        requireUnique(sourceItemIds, itemId, `${itemPath}.id`, "item");
        const itemType = requireIdentifier(item.type, `${itemPath}.type`);

        for (const mapped of mapItem(item, itemId, itemType, itemPath)) {
          requireUnique(
            mappedItemIds,
            mapped.id,
            `${itemPath}.id`,
            "mapped item",
          );
          mappedItems.push(mapped);
        }
      }

      return { id: turnId, items: mappedItems };
    }),
  };
}

function mapItem(
  item: JsonRecord,
  id: string,
  type: string,
  path: string,
): readonly AgentConversationItem[] {
  switch (type) {
    case "userMessage":
      return [mapUserMessage(item, id, path)];
    case "agentMessage":
      return [
        {
          id,
          type: "agent_message",
          content: requireString(item.text, `${path}.text`),
        },
      ];
    case "commandExecution":
      return mapCommandExecution(item, id, path);
    case "mcpToolCall":
      return mapMcpToolCall(item, id, path);
    case "dynamicToolCall":
      return mapDynamicToolCall(item, id, path);
    case "fileChange":
      return mapFileChanges(item, id, path);
    default:
      return [mapOther(item, id, type)];
  }
}

function mapUserMessage(
  item: JsonRecord,
  id: string,
  path: string,
): AgentConversationItem {
  const inputs = requireArray(item.content, `${path}.content`);
  const content = inputs
    .map((inputValue, inputIndex) =>
      renderUserInput(inputValue, `${path}.content[${String(inputIndex)}]`),
    )
    .join("\n");
  return { id, type: "user_message", content };
}

function renderUserInput(value: unknown, path: string): string {
  const input = requireRecord(value, path);
  const type = requireIdentifier(input.type, `${path}.type`);
  switch (type) {
    case "text":
      return requireString(input.text, `${path}.text`);
    case "image":
      return renderReference("Image", input.url);
    case "localImage":
      return renderReference("Local image", input.path);
    case "audio":
      return renderReference("Audio", input.url);
    case "localAudio":
      return renderReference("Local audio", input.path);
    case "skill":
      return renderNamedReference("Skill", input.name, input.path);
    case "mention":
      return renderNamedReference("Mention", input.name, input.path);
    default:
      return `[Unsupported user input: ${type}]`;
  }
}

function mapCommandExecution(
  item: JsonRecord,
  id: string,
  path: string,
): readonly AgentConversationItem[] {
  const resultId = derivedId(id, "result");
  const result: AgentConversationItem = {
    id: resultId,
    type: "command_result",
    commandId: id,
    ...optionalString(
      item.aggregatedOutput,
      "content",
      `${path}.aggregatedOutput`,
    ),
    ...optionalInteger(item.exitCode, "exitCode", `${path}.exitCode`),
  };
  return [
    {
      id,
      type: "command_execution",
      command: requireString(item.command, `${path}.command`),
    },
    result,
  ];
}

function mapMcpToolCall(
  item: JsonRecord,
  id: string,
  path: string,
): readonly AgentConversationItem[] {
  const server = requireIdentifier(item.server, `${path}.server`);
  const tool = requireIdentifier(item.tool, `${path}.tool`);
  const error = optionalRecord(item.error, `${path}.error`);
  const result = optionalRecord(item.result, `${path}.result`);
  const content = error
    ? requireString(error.message, `${path}.error.message`)
    : renderMcpResult(result, `${path}.result`);

  return [
    {
      id,
      type: "tool_call",
      name: `${server}.${tool}`,
      arguments: stableJson(item.arguments, `${path}.arguments`),
    },
    {
      id: derivedId(id, "result"),
      type: "tool_result",
      callId: id,
      ...(content === undefined ? {} : { content }),
      isError: error !== undefined || item.status === "failed",
    },
  ];
}

function mapDynamicToolCall(
  item: JsonRecord,
  id: string,
  path: string,
): readonly AgentConversationItem[] {
  const tool = requireIdentifier(item.tool, `${path}.tool`);
  const namespace = optionalNonEmptyString(item.namespace, `${path}.namespace`);
  const contentItems = optionalArray(item.contentItems, `${path}.contentItems`);
  const content = contentItems
    ?.map((value, index) =>
      renderDynamicToolContent(value, `${path}.contentItems[${String(index)}]`),
    )
    .join("\n");

  return [
    {
      id,
      type: "tool_call",
      name: namespace === undefined ? tool : `${namespace}.${tool}`,
      arguments: stableJson(item.arguments, `${path}.arguments`),
    },
    {
      id: derivedId(id, "result"),
      type: "tool_result",
      callId: id,
      ...(content === undefined ? {} : { content }),
      isError: item.success === false || item.status === "failed",
    },
  ];
}

function mapFileChanges(
  item: JsonRecord,
  id: string,
  path: string,
): readonly AgentConversationItem[] {
  const changes = requireArray(item.changes, `${path}.changes`);
  if (changes.length === 0) return [mapOther(item, id, "fileChange")];

  return changes.map((changeValue, index) => {
    const changePath = `${path}.changes[${String(index)}]`;
    const change = requireRecord(changeValue, changePath);
    const kind = requireRecord(change.kind, `${changePath}.kind`);
    const kindType = requireIdentifier(kind.type, `${changePath}.kind.type`);
    const mappedKind = mapFileChangeKind(kindType);
    const derived = derivedId(id, `change:${String(index + 1)}`);
    if (mappedKind === undefined)
      return {
        id: derived,
        type: "other" as const,
        label: `Codex fileChange (${kindType})`,
        content: `Path: ${requireString(change.path, `${changePath}.path`)}`,
      };
    return {
      id: derived,
      type: "file_change" as const,
      path: requireString(change.path, `${changePath}.path`),
      change: mappedKind,
      patch: requireString(change.diff, `${changePath}.diff`),
    };
  });
}

function mapFileChangeKind(value: string): AgentFileChangeKind | undefined {
  switch (value) {
    case "add":
      return "created";
    case "update":
      return "updated";
    case "delete":
      return "deleted";
    default:
      return undefined;
  }
}

function mapOther(
  item: JsonRecord,
  id: string,
  itemType: string,
): AgentConversationItem {
  const safeLines: string[] = [];
  appendSafeText(safeLines, "Text", item.text);
  appendSafeText(safeLines, "Query", item.query);
  appendSafeText(safeLines, "Path", item.path);
  appendSafeText(safeLines, "Review", item.review);
  appendSafePrimitive(safeLines, "Status", item.status);
  return {
    id,
    type: "other",
    label: `Codex ${itemType}`,
    ...(safeLines.length === 0 ? {} : { content: safeLines.join("\n") }),
  };
}

function renderMcpResult(
  result: JsonRecord | undefined,
  path: string,
): string | undefined {
  if (result === undefined) return undefined;
  const content = requireArray(result.content, `${path}.content`);
  return content
    .map((value, index) =>
      renderMcpContent(value, `${path}.content[${String(index)}]`),
    )
    .join("\n");
}

function renderMcpContent(value: unknown, path: string): string {
  if (typeof value === "string") return value;
  const content = requireRecord(value, path);
  if (content.type === "text")
    return requireString(content.text, `${path}.text`);
  return `[${typeof content.type === "string" ? content.type : "non-text content"}]`;
}

function renderDynamicToolContent(value: unknown, path: string): string {
  const content = requireRecord(value, path);
  const type = requireIdentifier(content.type, `${path}.type`);
  if (type === "inputText") return requireString(content.text, `${path}.text`);
  return `[${type}]`;
}

function renderReference(label: string, value: unknown): string {
  return typeof value === "string" && value.length > 0
    ? `[${label}: ${value}]`
    : `[${label}]`;
}

function renderNamedReference(
  label: string,
  nameValue: unknown,
  pathValue: unknown,
): string {
  const name = typeof nameValue === "string" ? nameValue : "";
  const path = typeof pathValue === "string" ? pathValue : "";
  const details = [name, path].filter((part) => part.length > 0).join(": ");
  return details.length > 0 ? `[${label}: ${details}]` : `[${label}]`;
}

function appendSafeText(lines: string[], label: string, value: unknown): void {
  if (typeof value === "string") lines.push(`${label}: ${value}`);
}

function appendSafePrimitive(
  lines: string[],
  label: string,
  value: unknown,
): void {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    lines.push(`${label}: ${String(value)}`);
}

function stableJson(value: unknown, path: string): string {
  validateJsonValue(value, path);
  return JSON.stringify(sortJsonValue(value));
}

function validateJsonValue(value: unknown, path: string): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateJsonValue(entry, `${path}[${String(index)}]`),
    );
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value))
      validateJsonValue(entry, `${path}.${key}`);
    return;
  }
  throw protocolError(path, "must contain JSON-compatible data");
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function requireRecord(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) throw protocolError(path, "must be an object");
  return value;
}

function optionalRecord(value: unknown, path: string): JsonRecord | undefined {
  if (value === null || value === undefined) return undefined;
  return requireRecord(value, path);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw protocolError(path, "must be an array");
  return value;
}

function optionalArray(
  value: unknown,
  path: string,
): readonly unknown[] | undefined {
  if (value === null || value === undefined) return undefined;
  return requireArray(value, path);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw protocolError(path, "must be a string");
  return value;
}

function requireIdentifier(value: unknown, path: string): string {
  const identifier = requireString(value, path);
  if (identifier.length === 0)
    throw protocolError(path, "must be a non-empty string");
  return identifier;
}

function optionalNonEmptyString(
  value: unknown,
  path: string,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requireIdentifier(value, path);
}

function optionalString<K extends string>(
  value: unknown,
  key: K,
  path: string,
): Partial<Record<K, string>> {
  if (value === null || value === undefined) return {};
  return { [key]: requireString(value, path) } as Record<K, string>;
}

function optionalInteger<K extends string>(
  value: unknown,
  key: K,
  path: string,
): Partial<Record<K, number>> {
  if (value === null || value === undefined) return {};
  if (!Number.isSafeInteger(value))
    throw protocolError(path, "must be an integer or null");
  return { [key]: value } as Record<K, number>;
}

function requireUnique(
  seen: Set<string>,
  value: string,
  path: string,
  kind: string,
): void {
  if (seen.has(value))
    throw protocolError(path, `duplicates the ${kind} identifier ${value}`);
  seen.add(value);
}

function derivedId(id: string, suffix: string): string {
  return `${id}:${suffix}`;
}

function protocolError(
  path: string,
  message: string,
): CodexConversationProtocolError {
  return new CodexConversationProtocolError(path, message);
}
