import {
  AgentRuntimeIncompatibleError,
  AgentRuntimeUnavailableError,
  type AgentConversation,
  type AgentInteractiveRequest,
  type AgentSessionId,
  type AgentSessionOptions,
  type AgentSessions,
  type AgentTurnRequest,
  type AgentTurnResult,
  type InteractiveExit,
} from "../../../../ports/agent-sessions.js";
import {
  cleanupError,
  CodexAppServerSessionsError,
  isUnsupportedEphemeralError,
  mapCompatibilityError,
  mapStartupError,
  sessionOperationError,
} from "./codex-app-server-errors.js";
import { mapCodexConversation } from "./codex-conversation-mapper.js";
import {
  CodexJsonRpcClient,
  CodexJsonRpcClientError,
  type CodexJsonRpcClientOptions,
  type CodexJsonRpcValue,
  type CodexTurnCompletedNotification,
} from "./codex-json-rpc-client.js";
import {
  CodexProcessRuntime,
  type CodexControlTransport,
} from "./codex-process-runtime.js";

type AdapterState = "idle" | "started" | "stopping";
type EphemeralSupport = "unknown" | "supported" | "unsupported";

interface SessionRecord {
  currentDirectory: string;
  retention: "managed" | "persistent";
}

export interface CodexAppServerSessionsOptions {
  runtime: CodexProcessRuntime;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
  createClient?: (options: CodexJsonRpcClientOptions) => CodexJsonRpcClient;
}

const analysisOutputSchema = {
  type: "object",
  properties: {
    markdown: { type: "string", minLength: 1, pattern: "\\S" },
  },
  required: ["markdown"],
  additionalProperties: false,
} as const satisfies CodexJsonRpcValue;

export class CodexAppServerSessions implements AgentSessions {
  private readonly runtime: CodexProcessRuntime;
  private readonly clientName: string;
  private readonly clientTitle: string;
  private readonly clientVersion: string;
  private readonly createClient: (
    options: CodexJsonRpcClientOptions,
  ) => CodexJsonRpcClient;
  private readonly sessions = new Map<AgentSessionId, SessionRecord>();
  private state: AdapterState = "idle";
  private client?: CodexJsonRpcClient;
  private stopping?: Promise<void>;
  private ephemeralSupport: EphemeralSupport = "unknown";

  constructor(options: CodexAppServerSessionsOptions) {
    this.runtime = options.runtime;
    this.clientName = options.clientName ?? "happy_machine";
    this.clientTitle = options.clientTitle ?? "Happy Machine";
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.createClient =
      options.createClient ??
      ((clientOptions) => new CodexJsonRpcClient(clientOptions));
  }

  async checkCompatibility(): Promise<void> {
    try {
      await this.runtime.checkCompatibility();
    } catch (error) {
      throw mapCompatibilityError(error);
    }
  }

  async start(): Promise<void> {
    if (this.state !== "idle") throw this.invalidState("start");

    let transport: CodexControlTransport | undefined;
    let client: CodexJsonRpcClient | undefined;
    try {
      transport = await this.runtime.start();
      client = this.createClient(transport);
      await client.initialize({
        clientInfo: {
          name: this.clientName,
          title: this.clientTitle,
          version: this.clientVersion,
        },
        capabilities: { experimentalApi: true },
      });
      this.client = client;
      this.state = "started";
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      if (client !== undefined) {
        try {
          await client.shutdown();
        } catch (cleanupFailure) {
          cleanupFailures.push(cleanupFailure);
        }
      }
      if (transport !== undefined) {
        try {
          await this.runtime.stop();
        } catch (cleanupFailure) {
          cleanupFailures.push(cleanupFailure);
        }
      }
      const startupError = mapStartupError(error);
      const allCleanupFailures = [
        ...startupError.cleanupFailures,
        ...cleanupFailures,
      ];
      if (allCleanupFailures.length > 0) {
        const options = {
          cause: new AggregateError([error, ...cleanupFailures]),
          cleanupFailures: allCleanupFailures,
        };
        throw startupError instanceof AgentRuntimeUnavailableError
          ? new AgentRuntimeUnavailableError(startupError.message, options)
          : new AgentRuntimeIncompatibleError(startupError.message, options);
      }
      throw startupError;
    }
  }

  async createSession(options: AgentSessionOptions): Promise<AgentSessionId> {
    const client = this.requireClient("create a session");
    requireNonEmpty(options.currentDirectory, "currentDirectory");

    let result: CodexJsonRpcValue;
    try {
      result = await this.startThread(client, options);
    } catch (error) {
      throw sessionOperationError("create a session", error);
    }

    const thread = requireRecord(result, "thread/start result").thread;
    const id = requireIdentifier(
      requireRecord(thread, "thread/start result.thread").id,
      "thread/start result.thread.id",
    );
    if (this.sessions.has(id)) {
      throw new CodexAppServerSessionsError(
        "protocol_error",
        "The Codex app-server returned a duplicate session identifier.",
      );
    }
    this.sessions.set(id, {
      currentDirectory: options.currentDirectory,
      retention: options.retention,
    });
    return id;
  }

  async runInteractive(
    sessionId: AgentSessionId,
    request: AgentInteractiveRequest = {},
  ): Promise<InteractiveExit> {
    const session = this.requireSession(
      sessionId,
      "run an interactive session",
    );
    try {
      return await this.runtime.runTui({
        threadId: sessionId,
        currentDirectory: session.currentDirectory,
        initialPrompt: request.initialPrompt,
        signal: request.signal,
      });
    } catch (error) {
      throw sessionOperationError("run an interactive session", error);
    }
  }

  async runTurn(
    sessionId: AgentSessionId,
    request: AgentTurnRequest,
  ): Promise<AgentTurnResult> {
    const client = this.requireClient("run a turn");
    const session = this.requireSession(sessionId, "run a turn");
    let turnId: string | undefined;

    try {
      const started = await client.request(
        "turn/start",
        {
          threadId: sessionId,
          input: [{ type: "text", text: request.prompt }],
          cwd: session.currentDirectory,
          approvalPolicy: "never",
          sandboxPolicy:
            request.filesystem === "read-only"
              ? { type: "readOnly", networkAccess: request.network }
              : {
                  type: "workspaceWrite",
                  writableRoots: [session.currentDirectory],
                  networkAccess: request.network,
                },
          outputSchema: analysisOutputSchema,
        },
        { signal: request.signal },
      );
      turnId = requireIdentifier(
        requireRecord(
          requireRecord(started, "turn/start result").turn,
          "turn/start result.turn",
        ).id,
        "turn/start result.turn.id",
      );
      const completion = await client.waitForTurnCompletion(sessionId, turnId, {
        signal: request.signal,
      });
      return mapTurnResult(completion);
    } catch (error) {
      if (isAbortError(error, request.signal)) {
        if (turnId !== undefined)
          await this.interruptTurn(client, sessionId, turnId);
        return { status: "interrupted" };
      }
      throw sessionOperationError("complete the analysis turn", error);
    }
  }

  async readConversation(
    sessionId: AgentSessionId,
  ): Promise<AgentConversation> {
    const client = this.requireClient("read a conversation");
    this.requireSession(sessionId, "read a conversation");
    try {
      const result = await client.request("thread/read", {
        threadId: sessionId,
        includeTurns: true,
      });
      return mapCodexConversation(
        requireRecord(result, "thread/read result").thread,
      );
    } catch (error) {
      throw sessionOperationError("read a conversation", error);
    }
  }

  async disposeSession(sessionId: AgentSessionId): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    const client = this.requireClient("dispose a session");
    try {
      await client.request("thread/delete", { threadId: sessionId });
      this.sessions.delete(sessionId);
    } catch (error) {
      throw sessionOperationError("dispose a session", error);
    }
  }

  async stop(): Promise<void> {
    if (this.state === "idle") return;
    if (this.stopping !== undefined) return this.stopping;
    this.state = "stopping";
    this.stopping = this.performStop();
    try {
      await this.stopping;
    } finally {
      this.stopping = undefined;
      this.state = "idle";
      this.client = undefined;
      this.sessions.clear();
      this.ephemeralSupport = "unknown";
    }
  }

  private async startThread(
    client: CodexJsonRpcClient,
    options: AgentSessionOptions,
  ): Promise<CodexJsonRpcValue> {
    if (options.retention === "persistent") {
      return client.request("thread/start", { cwd: options.currentDirectory });
    }
    if (this.ephemeralSupport === "unsupported") {
      return client.request("thread/start", { cwd: options.currentDirectory });
    }

    try {
      const result = await client.request("thread/start", {
        cwd: options.currentDirectory,
        ephemeral: true,
      });
      this.ephemeralSupport = "supported";
      return result;
    } catch (error) {
      if (!isUnsupportedEphemeralError(error)) throw error;
      this.ephemeralSupport = "unsupported";
      return client.request("thread/start", { cwd: options.currentDirectory });
    }
  }

  private async interruptTurn(
    client: CodexJsonRpcClient,
    threadId: string,
    turnId: string,
  ): Promise<void> {
    try {
      await client.request("turn/interrupt", { threadId, turnId });
    } catch {
      // Runtime shutdown remains the bounded fallback for an interrupted turn.
    }
  }

  private async performStop(): Promise<void> {
    const errors: unknown[] = [];
    const client = this.client;
    if (client !== undefined) {
      const managedIds = [...this.sessions]
        .filter(([, session]) => session.retention === "managed")
        .map(([id]) => id);
      for (const id of managedIds) {
        try {
          await client.request("thread/delete", { threadId: id });
          this.sessions.delete(id);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await client.shutdown();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.runtime.stop();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw cleanupError(errors);
  }

  private requireClient(operation: string): CodexJsonRpcClient {
    if (this.state !== "started" || this.client === undefined)
      throw this.invalidState(operation);
    return this.client;
  }

  private requireSession(sessionId: string, operation: string): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (session === undefined)
      throw new CodexAppServerSessionsError(
        "invalid_state",
        `The Codex app-server cannot ${operation} for an unknown session.`,
      );
    return session;
  }

  private invalidState(operation: string): CodexAppServerSessionsError {
    return new CodexAppServerSessionsError(
      "invalid_state",
      `The Codex app-server session adapter cannot ${operation} in its current state.`,
    );
  }
}

function mapTurnResult(
  completion: CodexTurnCompletedNotification,
): AgentTurnResult {
  const turn = requireRecord(completion.turn, "turn/completed turn");
  const status = turn.status;
  if (status === "interrupted") return { status: "interrupted" };
  if (status === "failed") return { status: "failed" };
  if (status !== "completed") {
    throw new CodexAppServerSessionsError(
      "protocol_error",
      "The Codex app-server returned an unsupported analysis turn status.",
    );
  }

  const items = turn.items;
  if (!Array.isArray(items)) {
    throw new CodexAppServerSessionsError(
      "protocol_error",
      "The Codex app-server omitted the completed analysis turn items.",
    );
  }
  const completedItems: readonly unknown[] = items;
  let finalMessage: unknown;
  for (let index = completedItems.length - 1; index >= 0; index -= 1) {
    const candidate = completedItems[index];
    if (isRecord(candidate) && candidate.type === "agentMessage") {
      finalMessage = candidate;
      break;
    }
  }
  if (!isRecord(finalMessage) || typeof finalMessage.text !== "string") {
    throw new CodexAppServerSessionsError(
      "protocol_error",
      "The Codex app-server omitted the structured analysis result.",
    );
  }
  return {
    status: "completed",
    content: parseStructuredMarkdown(finalMessage.text),
  };
}

function parseStructuredMarkdown(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new CodexAppServerSessionsError(
      "protocol_error",
      "The Codex app-server returned an invalid structured analysis result.",
      { cause: error },
    );
  }
  if (!isRecord(parsed)) throw invalidStructuredResult();
  const keys = Object.keys(parsed);
  if (
    keys.length !== 1 ||
    keys[0] !== "markdown" ||
    typeof parsed.markdown !== "string" ||
    parsed.markdown.trim().length === 0
  ) {
    throw invalidStructuredResult();
  }
  return parsed.markdown;
}

function invalidStructuredResult(): CodexAppServerSessionsError {
  return new CodexAppServerSessionsError(
    "protocol_error",
    "The Codex app-server returned an invalid structured analysis result.",
  );
}

function isAbortError(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof CodexJsonRpcClientError && error.code === "aborted")
  );
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new CodexAppServerSessionsError(
      "protocol_error",
      `The Codex app-server returned malformed data at ${path}.`,
    );
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new CodexAppServerSessionsError(
      "protocol_error",
      `The Codex app-server returned a missing identifier at ${path}.`,
    );
  return value;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0)
    throw new TypeError(`${label} must be non-empty`);
}
