export type AgentSessionId = string;

export type AgentSessionRetention = "managed" | "persistent";

export interface AgentSessionOptions {
  currentDirectory: string;
  retention: AgentSessionRetention;
}

export interface InteractiveExit {
  reason: "normal" | "interrupted" | "failed";
  exitCode?: number;
}

export interface AgentInteractiveRequest {
  initialPrompt?: string;
  readableResources?: readonly string[];
  signal?: AbortSignal;
}

export interface AgentTurnRequest {
  prompt: string;
  filesystem: "read-only" | "workspace-write";
  network: boolean;
  expectedResult: "markdown";
  readableResources: readonly string[];
  signal?: AbortSignal;
}

export interface AgentTurnResult {
  status: "completed" | "interrupted" | "failed";
  content?: string;
}

export interface AgentRuntimeErrorOptions extends ErrorOptions {
  cleanupFailures?: readonly unknown[];
}

export class AgentRuntimeUnavailableError extends Error {
  override readonly name = "AgentRuntimeUnavailableError";

  constructor(message?: string, options: AgentRuntimeErrorOptions = {}) {
    super(message, options);
    this.cleanupFailures = options.cleanupFailures ?? [];
  }

  readonly cleanupFailures: readonly unknown[];
}

export class AgentRuntimeIncompatibleError extends Error {
  override readonly name = "AgentRuntimeIncompatibleError";

  constructor(message?: string, options: AgentRuntimeErrorOptions = {}) {
    super(message, options);
    this.cleanupFailures = options.cleanupFailures ?? [];
  }

  readonly cleanupFailures: readonly unknown[];
}

interface AgentConversationItemBase {
  id: string;
}

export interface AgentUserMessage extends AgentConversationItemBase {
  type: "user_message";
  content: string;
}

export interface AgentMessage extends AgentConversationItemBase {
  type: "agent_message";
  content: string;
}

export interface AgentCommandExecution extends AgentConversationItemBase {
  type: "command_execution";
  command: string;
}

export interface AgentCommandResult extends AgentConversationItemBase {
  type: "command_result";
  commandId: string;
  content?: string;
  exitCode?: number;
}

export interface AgentToolCall extends AgentConversationItemBase {
  type: "tool_call";
  name: string;
  arguments?: string;
}

export interface AgentToolResult extends AgentConversationItemBase {
  type: "tool_result";
  callId: string;
  content?: string;
  isError?: boolean;
}

export type AgentFileChangeKind = "created" | "updated" | "deleted";

export interface AgentFileChange extends AgentConversationItemBase {
  type: "file_change";
  path: string;
  change: AgentFileChangeKind;
  patch?: string;
}

export interface AgentOtherItem extends AgentConversationItemBase {
  type: "other";
  label: string;
  content?: string;
}

export type AgentConversationItem =
  | AgentUserMessage
  | AgentMessage
  | AgentCommandExecution
  | AgentCommandResult
  | AgentToolCall
  | AgentToolResult
  | AgentFileChange
  | AgentOtherItem;

export interface AgentConversationTurn {
  id: string;
  items: readonly AgentConversationItem[];
}

export interface AgentConversation {
  turns: readonly AgentConversationTurn[];
}

export interface AgentSessions {
  checkCompatibility(): Promise<void>;
  start(): Promise<void>;
  createSession(options: AgentSessionOptions): Promise<AgentSessionId>;
  runInteractive(
    sessionId: AgentSessionId,
    request?: AgentInteractiveRequest,
  ): Promise<InteractiveExit>;
  runTurn(
    sessionId: AgentSessionId,
    request: AgentTurnRequest,
  ): Promise<AgentTurnResult>;
  readConversation(sessionId: AgentSessionId): Promise<AgentConversation>;
  disposeSession(sessionId: AgentSessionId): Promise<void>;
  stop(): Promise<void>;
}
