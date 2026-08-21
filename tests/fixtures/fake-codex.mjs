#!/usr/bin/env node
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

// Explicit controls for adapter and end-to-end tests:
//   FAKE_CODEX_LOG=/absolute/calls.jsonl
//   FAKE_CODEX_CONFIG={
//     "eventOrder":"response-first|notifications-first|reverse-notifications",
//     "interleavedNotifications":true,
//     "unsupportedEphemeral":true,
//     "emptyConversation":true,
//     "invalidAnalysis":true,
//     "analysisWait":true,
//     "captureSentinel":"sensitive-test-value",
//     "corruptCaptureOwnerOnMethod":"turn/start",
//     "replaceDemonstrationWithDirectoryOnMethod":"turn/start",
//     "malformedJsonMethods":["thread/read"],
//     "jsonRpcErrors":{"turn/start":{"code":-32001,"message":"failed"}},
//     "threadDeleteErrors":["thread-generation"],
//     "lifecycle":{"demonstration|generation|appServer|proxy":{
//       "exit":"normal|nonzero|signal|wait", "code":17,
//       "signal":"SIGTERM", "shutdownDelayMs":25,
//       "replaceSocketWithFileOnShutdown":true
//     }}
//   }
const args = process.argv.slice(2);
const config = JSON.parse(process.env.FAKE_CODEX_CONFIG ?? "{}");
const logPath = process.env.FAKE_CODEX_LOG
  ? path.resolve(process.env.FAKE_CODEX_LOG)
  : path.join(process.cwd(), ".fake-codex-calls.jsonl");

const log = (event, details = {}) => {
  appendFileSync(logPath, `${JSON.stringify({ event, ...details })}\n`);
};

const sendReady = (role, details = {}) => {
  if (typeof process.send === "function") process.send({ role, ...details });
};

const lifecycleFor = (role) => config.lifecycle?.[role] ?? {};

const exitFromLifecycle = (role) => {
  const lifecycle = lifecycleFor(role);
  const exit = lifecycle.exit ?? "normal";
  if (exit === "normal") process.exit(lifecycle.code ?? 0);
  if (exit === "nonzero") process.exit(lifecycle.code ?? 17);
  if (exit === "signal") {
    const signal = lifecycle.signal ?? "SIGTERM";
    log("self_signal", { role, signal });
    process.kill(process.pid, signal);
    return;
  }
  if (exit !== "wait") {
    process.stderr.write(`unknown fake Codex lifecycle exit: ${exit}\n`);
    process.exit(2);
  }
  setInterval(() => {}, 2_147_483_647);
  setImmediate(() => sendReady(role));
};

const installShutdown = (role, cleanup = () => {}) => {
  let stopping = false;
  const stop = (signal) => {
    if (stopping) {
      cleanup();
      process.exit(0);
    }
    stopping = true;
    const delayMs = lifecycleFor(role).shutdownDelayMs ?? 0;
    log("shutdown_requested", { role, signal, delayMs });
    setTimeout(() => {
      cleanup();
      log("shutdown_completed", { role });
      process.exit(0);
    }, delayMs);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
};

log("spawn", { args });

if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
  process.stdout.write(`${config.version ?? "codex-cli 0.148.0"}\n`);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  const operation = args
    .filter((argument) => !argument.startsWith("-"))
    .join(" ");
  const help =
    operation === "app-server proxy"
      ? "Usage: codex app-server proxy --sock <SOCKET>\n"
      : operation === "app-server"
        ? "Usage: codex app-server --listen <URI>\nCommands: proxy\n"
        : operation === "resume"
          ? "Usage: codex resume --remote <URI> <THREAD_ID> [PROMPT]\n"
          : "Usage: codex <COMMAND>\nCommands: app-server, resume\n";
  process.stdout.write(help);
  process.exit(0);
}

const listenIndex = args.indexOf("--listen");
if (args[0] === "app-server" && listenIndex >= 0) {
  const listen = args[listenIndex + 1];
  if (!listen?.startsWith("unix://")) {
    process.stderr.write("fake Codex app-server requires a unix:// listener\n");
    process.exit(2);
  }
  const socketPath = new URL(listen).pathname;
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = net.createServer((socket) => socket.on("error", () => {}));
  const cleanup = () => {
    server.close();
    if (existsSync(socketPath)) unlinkSync(socketPath);
    if (lifecycleFor("appServer").replaceSocketWithFileOnShutdown)
      writeFileSync(socketPath, "configured shutdown residue\n", {
        mode: 0o600,
      });
  };
  installShutdown("appServer", cleanup);
  server.listen(socketPath, () => {
    log("ready", { role: "appServer", socketPath });
    sendReady("appServer", { socketPath });
    if (lifecycleFor("appServer").exit === "nonzero")
      process.exit(lifecycleFor("appServer").code ?? 17);
  });
} else if (args[0] === "app-server" && args[1] === "proxy") {
  const roles = ["demonstration", "analysis", "generation"];
  const threads = new Map();
  let nextThread = 0;
  const write = (message) => {
    const line = JSON.stringify(message);
    log("protocol_out", { message });
    process.stdout.write(`${line}\n`);
  };
  const malformed = (method) => {
    const line = config.malformedJsonMethods?.includes(method)
      ? (config.malformedJson ?? "{malformed-json")
      : undefined;
    if (line === undefined) return false;
    log("protocol_out_malformed", { method, line });
    process.stdout.write(`${line}\n`);
    return true;
  };
  const rpcError = (request) => {
    const configured =
      config.jsonRpcErrors?.[request.method] ??
      (request.method === "thread/delete" &&
      config.threadDeleteErrors?.includes(request.params?.threadId)
        ? {
            code: -32006,
            message: `configured delete failure for ${String(request.params?.threadId)}`,
          }
        : undefined);
    if (!configured) return false;
    write({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: configured.code ?? -32001,
        message: configured.message ?? `configured ${request.method} failure`,
        ...(configured.data === undefined ? {} : { data: configured.data }),
      },
    });
    return true;
  };
  const emitRequestEvents = (request, result, notifications = []) => {
    const response = { jsonrpc: "2.0", id: request.id, result };
    const orderedNotifications =
      config.eventOrder === "reverse-notifications"
        ? [...notifications].reverse()
        : notifications;
    const unrelated = {
      jsonrpc: "2.0",
      method: "account/updated",
      params: { accountId: "account-unrelated" },
    };
    if (config.eventOrder === "notifications-first") {
      for (const notification of orderedNotifications) write(notification);
      if (config.interleavedNotifications && notifications.length > 0)
        write(unrelated);
      write(response);
      return;
    }
    write(response);
    orderedNotifications.forEach((notification, index) => {
      write(notification);
      if (config.interleavedNotifications && index === 0) write(unrelated);
    });
  };
  const notification = (method, params) => ({
    jsonrpc: "2.0",
    method,
    params,
  });
  const conversationFor = (threadId) => {
    if (config.emptyConversation) return [];
    const sentinel = config.captureSentinel;
    return [
      {
        id: `turn-demonstration-for-${threadId}`,
        status: "completed",
        items: [
          {
            id: `item-user-for-${threadId}`,
            type: "userMessage",
            content: [
              {
                type: "text",
                text: sentinel ?? "Inspect the failing workflow",
              },
            ],
          },
          {
            id: `item-agent-for-${threadId}`,
            type: "agentMessage",
            text: sentinel ?? "I inspected it.",
          },
          {
            id: `item-command-for-${threadId}`,
            type: "commandExecution",
            command: "npm test",
            aggregatedOutput: sentinel ?? "all tests passed",
            exitCode: 0,
            status: "completed",
          },
          {
            id: `item-tool-for-${threadId}`,
            type: "mcpToolCall",
            server: "fixture",
            tool: "read_file",
            arguments: { path: "README.md" },
            result: {
              content: [{ type: "text", text: sentinel ?? "# Fixture" }],
            },
            status: "completed",
          },
          {
            id: `item-file-for-${threadId}`,
            type: "fileChange",
            changes: [
              {
                path: "README.md",
                kind: { type: "update" },
                diff: "+# Fixture",
              },
            ],
            status: "completed",
          },
          {
            id: `item-unknown-for-${threadId}`,
            type: "futureObservableItem",
            summary: "observable but unsupported",
          },
        ],
      },
    ];
  };
  const applyConfiguredCaptureSabotage = (request) => {
    const corruptOwner = config.corruptCaptureOwnerOnMethod === request.method;
    const replaceDemonstration =
      config.replaceDemonstrationWithDirectoryOnMethod === request.method;
    if (!corruptOwner && !replaceDemonstration) return;
    const prompt = request.params?.input?.find?.(
      (item) => item?.type === "text" && typeof item.text === "string",
    )?.text;
    const reference = parseAnalysisDemonstrationReference(prompt);
    if (reference === undefined) return;
    if (corruptOwner) {
      const markerPath = path.join(
        path.dirname(reference),
        ".capture-owner.json",
      );
      chmodSync(markerPath, 0o644);
      log("capture_owner_corrupted", { markerPath });
    }
    if (replaceDemonstration) {
      rmSync(reference, { force: true });
      mkdirSync(reference, { mode: 0o700 });
      log("demonstration_artifact_replaced", { reference });
    }
  };
  const handle = (request) => {
    log("protocol_in", { message: request });
    if (request.id === undefined) return;
    applyConfiguredCaptureSabotage(request);
    if (malformed(request.method) || rpcError(request)) return;
    if (request.method === "initialize") {
      emitRequestEvents(request, {
        userAgent: "fake-codex/0.148.0",
        capabilities: { experimentalApi: true },
      });
      return;
    }
    if (request.method === "thread/start") {
      if (config.unsupportedEphemeral && request.params?.ephemeral === true) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: "unknown field ephemeral" },
        });
        return;
      }
      const role = roles[nextThread] ?? `extra-${String(nextThread + 1)}`;
      nextThread += 1;
      const thread = {
        id: `thread-${role}`,
        ephemeral: request.params?.ephemeral === true,
        path: request.params?.ephemeral === true ? null : `/fake/${role}.jsonl`,
        turns: [],
      };
      threads.set(thread.id, thread);
      emitRequestEvents(request, { thread }, [
        notification("thread/started", { thread }),
      ]);
      return;
    }
    if (request.method === "thread/read") {
      const threadId = request.params?.threadId;
      const thread = threads.get(threadId) ?? {
        id: threadId,
        ephemeral: false,
        path: `/fake/${String(threadId)}.jsonl`,
        turns: [],
      };
      emitRequestEvents(request, {
        thread: { ...thread, turns: conversationFor(threadId) },
      });
      return;
    }
    if (
      request.method === "thread/archive" ||
      request.method === "thread/delete"
    ) {
      const threadId = request.params?.threadId;
      threads.delete(threadId);
      emitRequestEvents(request, {});
      return;
    }
    if (request.method === "turn/start") {
      const threadId = request.params?.threadId;
      const turn = {
        id: `turn-analysis-for-${threadId}`,
        threadId,
        status: "inProgress",
        items: [],
      };
      const item = {
        id: `item-analysis-for-${threadId}`,
        threadId,
        turnId: turn.id,
        type: "agentMessage",
        text: config.invalidAnalysis
          ? (config.invalidAnalysisContent ?? '{"markdown":"   "}')
          : JSON.stringify({
              markdown:
                "# Reusable workflow context\n\n1. Inspect the failure.\n2. Validate the fix.",
            }),
      };
      const completedTurn = { ...turn, status: "completed", items: [item] };
      if (config.analysisWait) {
        emitRequestEvents(request, { turn }, [
          notification("turn/started", { threadId, turn }),
        ]);
        return;
      }
      emitRequestEvents(request, { turn }, [
        notification("turn/started", { threadId, turn }),
        notification("item/started", {
          threadId,
          turnId: turn.id,
          item: { ...item, text: "" },
        }),
        notification("item/completed", {
          threadId,
          turnId: turn.id,
          item,
        }),
        notification("turn/completed", { threadId, turn: completedTurn }),
      ]);
      return;
    }
    if (request.method === "turn/interrupt") {
      emitRequestEvents(request, {});
      return;
    }
    write({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    });
  };

  installShutdown("proxy");
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    log("protocol_in_raw", { line });
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    handle(request);
  });
  input.on("close", () => {
    log("stdin_closed", { role: "proxy" });
    process.exit(lifecycleFor("proxy").closeCode ?? 0);
  });
  log("ready", { role: "proxy" });
  sendReady("proxy");
} else if (args[0] === "resume") {
  const remoteIndex = args.indexOf("--remote");
  const threadId = remoteIndex < 0 ? undefined : args[remoteIndex + 2];
  const initialPrompt = remoteIndex < 0 ? undefined : args[remoteIndex + 3];
  const role = initialPrompt === undefined ? "demonstration" : "generation";
  const contextReference =
    role === "generation"
      ? parseGenerationContextReference(initialPrompt)
      : undefined;
  log("tui_started", {
    role,
    remote: remoteIndex < 0 ? undefined : args[remoteIndex + 1],
    threadId,
    ...(initialPrompt === undefined ? {} : { initialPrompt }),
    ...(contextReference === undefined
      ? {}
      : {
          contextReference,
          contextExists: existsSync(contextReference),
          demonstrationExists: existsSync(
            path.join(path.dirname(contextReference), "demonstration.md"),
          ),
        }),
  });
  if (lifecycleFor(role).exit !== "signal") installShutdown(role);
  exitFromLifecycle(role);
} else {
  process.stderr.write(`unexpected fake Codex invocation: ${args.join(" ")}\n`);
  process.exit(2);
}

function parseGenerationContextReference(initialPrompt) {
  const prefix = "Analyzed workflow context reference: ";
  const line = initialPrompt
    ?.split("\n")
    .find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) return undefined;
  try {
    const value = JSON.parse(line.slice(prefix.length));
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseAnalysisDemonstrationReference(prompt) {
  const prefix =
    "Read the workflow demonstration from this opaque agent-readable reference: ";
  const line = prompt
    ?.split("\n")
    .find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) return undefined;
  try {
    const value = JSON.parse(line.slice(prefix.length));
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
