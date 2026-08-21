import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { lstat, unlink } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

import type { InteractiveExit } from "../../../../ports/agent-sessions.js";
import { upgradeCodexWebSocketControlTransport } from "./codex-websocket-control-transport.js";

type RuntimeState = "idle" | "starting" | "started" | "stopping";
type ProcessRole = "app-server" | "proxy" | "remote TUI";

export interface CodexControlTransport {
  readable: Readable;
  writable: Writable;
}

export interface CodexTuiRequest {
  currentDirectory: string;
  initialPrompt?: string;
  signal?: AbortSignal;
}

export type CodexSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface CodexProcessRuntimeOptions {
  executable: string;
  socketPath: string;
  currentDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  spawnProcess?: CodexSpawn;
  connectSocket?: (socketPath: string) => Socket;
  upgradeControlTransport?: CodexControlTransportUpgrade;
}

export type CodexControlTransportUpgrade = (
  transport: CodexControlTransport,
  timeoutMs: number,
) => Promise<CodexControlTransport>;

export type CodexProcessRuntimeErrorCode =
  | "unavailable"
  | "incompatible"
  | "invalid_state"
  | "spawn_failed"
  | "startup_failed"
  | "shutdown_failed";

export interface CodexProcessRuntimeErrorOptions extends ErrorOptions {
  cleanupFailures?: readonly unknown[];
}

export class CodexProcessRuntimeError extends Error {
  override readonly name = "CodexProcessRuntimeError";

  constructor(
    readonly code: CodexProcessRuntimeErrorCode,
    message: string,
    options: CodexProcessRuntimeErrorOptions = {},
  ) {
    super(message, options);
    this.cleanupFailures = options.cleanupFailures ?? [];
  }

  readonly cleanupFailures: readonly unknown[];
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

interface ManagedChild {
  role: ProcessRole;
  child: ChildProcess;
  exited: Promise<ProcessExit>;
  terminationRequested: boolean;
}

interface CompatibilityProbe {
  label: string;
  args: readonly string[];
  requiredPatterns: readonly RegExp[];
}

const defaultStartupTimeoutMs = 5_000;
const defaultShutdownTimeoutMs = 1_000;
const readinessRetryMs = 10;
const maximumCompatibilityOutputBytes = 64 * 1024;

const compatibilityProbes: readonly CompatibilityProbe[] = [
  {
    label: "app-server",
    args: ["app-server", "--help"],
    requiredPatterns: [/--listen\b/, /\bproxy\b/],
  },
  {
    label: "app-server proxy",
    args: ["app-server", "proxy", "--help"],
    requiredPatterns: [/--sock\b/],
  },
  {
    label: "remote TUI",
    args: ["--help"],
    requiredPatterns: [/--remote\b/],
  },
];

export class CodexProcessRuntime {
  private readonly executable: string;
  private readonly socketPath: string;
  private readonly endpoint: string;
  private readonly currentDirectory: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly spawnProcess: CodexSpawn;
  private readonly connectSocket: (socketPath: string) => Socket;
  private readonly upgradeControlTransport: CodexControlTransportUpgrade;
  private readonly activeTuis = new Set<ManagedChild>();
  private state: RuntimeState = "idle";
  private appServer?: ManagedChild;
  private proxy?: ManagedChild;
  private stopping?: Promise<void>;

  constructor(options: CodexProcessRuntimeOptions) {
    requireNonEmpty(options.executable, "executable");
    requireNonEmpty(options.socketPath, "socketPath");
    requirePositiveInteger(options.startupTimeoutMs, "startupTimeoutMs");
    requirePositiveInteger(options.shutdownTimeoutMs, "shutdownTimeoutMs");

    this.executable = options.executable;
    this.socketPath = options.socketPath;
    this.endpoint = `unix://${options.socketPath}`;
    this.currentDirectory = options.currentDirectory ?? process.cwd();
    this.environment = options.environment ?? process.env;
    this.startupTimeoutMs = options.startupTimeoutMs ?? defaultStartupTimeoutMs;
    this.shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.connectSocket =
      options.connectSocket ?? ((socketPath) => createConnection(socketPath));
    this.upgradeControlTransport =
      options.upgradeControlTransport ??
      ((transport, timeoutMs) =>
        upgradeCodexWebSocketControlTransport({ transport, timeoutMs }));
  }

  async checkCompatibility(): Promise<void> {
    for (const probe of compatibilityProbes) {
      const output = await this.runCompatibilityProbe(probe);
      if (!probe.requiredPatterns.every((pattern) => pattern.test(output))) {
        throw new CodexProcessRuntimeError(
          "incompatible",
          `Codex does not support the required ${probe.label} command form.`,
        );
      }
    }
  }

  async start(): Promise<CodexControlTransport> {
    if (this.state !== "idle") throw this.invalidState("start");
    this.state = "starting";

    try {
      await this.removeStaleSocket();
      this.appServer = this.spawnManaged(
        "app-server",
        ["app-server", "--listen", this.endpoint],
        {
          cwd: this.currentDirectory,
          env: this.environment,
          stdio: ["ignore", "ignore", "ignore"],
        },
      );
      await this.awaitSpawn(this.appServer);
      await this.awaitSocketReadiness(this.appServer);

      this.proxy = this.spawnManaged(
        "proxy",
        ["app-server", "proxy", "--sock", this.socketPath],
        {
          cwd: this.currentDirectory,
          env: this.environment,
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      await this.awaitSpawn(this.proxy);
      if (!this.proxy.child.stdin || !this.proxy.child.stdout) {
        throw new CodexProcessRuntimeError(
          "startup_failed",
          "Codex proxy did not expose its JSONL control streams.",
        );
      }

      const controlTransport = await this.upgradeControlTransport(
        {
          readable: this.proxy.child.stdout,
          writable: this.proxy.child.stdin,
        },
        this.startupTimeoutMs,
      );
      this.state = "started";
      return controlTransport;
    } catch (cause) {
      const startupError = normalizeRuntimeError(
        cause,
        "startup_failed",
        "Codex runtime could not be started.",
      );
      const cleanupErrors = await this.stopOwnedChildren();
      this.state = "idle";
      if (cleanupErrors.length > 0) {
        throw new CodexProcessRuntimeError(
          startupError.code,
          startupError.message,
          {
            cause: new AggregateError([startupError, ...cleanupErrors]),
            cleanupFailures: cleanupErrors,
          },
        );
      }
      throw startupError;
    }
  }

  async runTui(request: CodexTuiRequest): Promise<InteractiveExit> {
    if (this.state !== "started") throw this.invalidState("run a remote TUI");
    requireNonEmpty(request.currentDirectory, "currentDirectory");
    if (request.signal?.aborted) return { reason: "interrupted" };

    const args = ["--remote", this.endpoint];
    if (request.initialPrompt !== undefined) args.push(request.initialPrompt);
    const managed = this.spawnManaged("remote TUI", args, {
      cwd: request.currentDirectory,
      env: this.environment,
      stdio: "inherit",
    });
    this.activeTuis.add(managed);

    let aborted = false;
    let abortTermination: Promise<void> | undefined;
    const onAbort = () => {
      aborted = true;
      abortTermination ??= this.terminateChild(managed, "SIGINT");
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await this.awaitSpawn(managed);
      if (request.signal?.aborted) onAbort();
      const exit = await managed.exited;
      if (abortTermination) await abortTermination;
      if (aborted || managed.terminationRequested || exit.signal !== null)
        return { reason: "interrupted" };
      if (exit.error !== undefined) {
        throw new CodexProcessRuntimeError(
          "spawn_failed",
          "Codex remote TUI could not be launched.",
          { cause: exit.error },
        );
      }
      if (exit.code === 0) return { reason: "normal", exitCode: 0 };
      return {
        reason: "failed",
        ...(exit.code === null ? {} : { exitCode: exit.code }),
      };
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      this.activeTuis.delete(managed);
    }
  }

  async stop(): Promise<void> {
    if (this.state === "idle") return;
    if (this.stopping) return this.stopping;
    this.state = "stopping";
    this.stopping = this.performStop();
    try {
      await this.stopping;
    } finally {
      this.stopping = undefined;
    }
  }

  private async performStop(): Promise<void> {
    const errors = await this.stopOwnedChildren();
    this.state = "idle";
    if (errors.length > 0) {
      throw new CodexProcessRuntimeError(
        "shutdown_failed",
        "Codex runtime shutdown did not complete cleanly.",
        { cause: new AggregateError(errors), cleanupFailures: errors },
      );
    }
  }

  private async runCompatibilityProbe(
    probe: CompatibilityProbe,
  ): Promise<string> {
    let child: ChildProcess;
    try {
      child = this.spawnProcess(this.executable, probe.args, {
        cwd: this.currentDirectory,
        env: this.environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      throw unavailableError(cause);
    }

    let output = "";
    const collect = (chunk: Buffer | string) => {
      if (Buffer.byteLength(output) >= maximumCompatibilityOutputBytes) return;
      output += String(chunk).slice(
        0,
        maximumCompatibilityOutputBytes - Buffer.byteLength(output),
      );
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const exit = await withTimeout(
      observeExit(child),
      this.startupTimeoutMs,
      async () => {
        await this.terminateChild(
          {
            role: "remote TUI",
            child,
            exited: observeExit(child),
            terminationRequested: false,
          },
          "SIGTERM",
        );
      },
    ).catch((cause: unknown) => {
      throw new CodexProcessRuntimeError(
        "incompatible",
        `Codex ${probe.label} compatibility check did not complete.`,
        { cause },
      );
    });

    if (exit.error !== undefined) throw unavailableError(exit.error);
    if (exit.signal !== null || exit.code !== 0) {
      throw new CodexProcessRuntimeError(
        "incompatible",
        `Codex ${probe.label} compatibility check failed.`,
        {
          cause: new Error(
            `Process exit: code=${String(exit.code)} signal=${String(exit.signal)}`,
          ),
        },
      );
    }
    return output;
  }

  private spawnManaged(
    role: ProcessRole,
    args: readonly string[],
    options: SpawnOptions,
  ): ManagedChild {
    let child: ChildProcess;
    try {
      child = this.spawnProcess(this.executable, args, {
        ...options,
        shell: false,
      });
    } catch (cause) {
      throw new CodexProcessRuntimeError(
        "spawn_failed",
        `Codex ${role} process could not be spawned.`,
        { cause },
      );
    }
    return {
      role,
      child,
      exited: observeExit(child),
      terminationRequested: false,
    };
  }

  private async awaitSpawn(managed: ManagedChild): Promise<void> {
    if (managed.child.pid !== undefined) return;
    const exit = await managed.exited;
    throw new CodexProcessRuntimeError(
      "spawn_failed",
      `Codex ${managed.role} process could not be spawned.`,
      { cause: exit.error },
    );
  }

  private async awaitSocketReadiness(appServer: ManagedChild): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      const connected = await this.tryConnect(deadline - Date.now());
      if (connected) return;

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const result = await Promise.race([
        appServer.exited.then((exit) => ({ kind: "exit" as const, exit })),
        delay(Math.min(readinessRetryMs, remaining)).then(() => ({
          kind: "retry" as const,
        })),
      ]);
      if (result.kind === "exit") {
        throw childExitedBeforeReady(appServer.role, result.exit);
      }
    }

    throw new CodexProcessRuntimeError(
      "startup_failed",
      `Codex app-server did not accept its private Unix socket within ${String(this.startupTimeoutMs)}ms.`,
    );
  }

  private tryConnect(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const socket = this.connectSocket(this.socketPath);
      const finish = (connected: boolean) => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        resolve(connected);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(Math.max(1, timeoutMs), () => finish(false));
    });
  }

  private async removeStaleSocket(): Promise<void> {
    try {
      const stats = await lstat(this.socketPath);
      if (!stats.isSocket()) {
        throw new CodexProcessRuntimeError(
          "startup_failed",
          "The configured Codex socket path is occupied by a non-socket entry.",
        );
      }
      await unlink(this.socketPath);
    } catch (cause) {
      if (isFileSystemError(cause, "ENOENT")) return;
      if (cause instanceof CodexProcessRuntimeError) throw cause;
      throw new CodexProcessRuntimeError(
        "startup_failed",
        "The private Codex socket could not be prepared.",
        { cause },
      );
    }
  }

  private async stopOwnedChildren(): Promise<unknown[]> {
    const errors: unknown[] = [];
    const attempt = async (operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };

    await Promise.all(
      [...this.activeTuis].map((tui) =>
        attempt(() => this.terminateChild(tui, "SIGINT")),
      ),
    );
    this.activeTuis.clear();
    if (this.proxy)
      await attempt(() => this.terminateChild(this.proxy!, "SIGTERM"));
    if (this.appServer)
      await attempt(() => this.terminateChild(this.appServer!, "SIGTERM"));
    this.proxy = undefined;
    this.appServer = undefined;
    await attempt(() => this.removeSocketAfterShutdown());
    return errors;
  }

  private async terminateChild(
    managed: ManagedChild,
    gracefulSignal: NodeJS.Signals,
  ): Promise<void> {
    const alreadyExited = await settledValue(managed.exited);
    if (alreadyExited !== undefined) return;

    managed.terminationRequested = true;
    managed.child.kill(gracefulSignal);
    if (await settlesWithin(managed.exited, this.shutdownTimeoutMs)) return;
    managed.child.kill("SIGTERM");
    if (await settlesWithin(managed.exited, this.shutdownTimeoutMs)) return;
    managed.child.kill("SIGKILL");
    if (await settlesWithin(managed.exited, this.shutdownTimeoutMs)) return;
    throw new CodexProcessRuntimeError(
      "shutdown_failed",
      `Codex ${managed.role} process did not exit after forced termination.`,
    );
  }

  private async removeSocketAfterShutdown(): Promise<void> {
    try {
      const stats = await lstat(this.socketPath);
      if (!stats.isSocket()) {
        throw new CodexProcessRuntimeError(
          "shutdown_failed",
          "The Codex socket path contains an unexpected non-socket entry after shutdown.",
        );
      }
      await unlink(this.socketPath);
    } catch (cause) {
      if (!isFileSystemError(cause, "ENOENT")) throw cause;
    }
  }

  private invalidState(operation: string): CodexProcessRuntimeError {
    return new CodexProcessRuntimeError(
      "invalid_state",
      `Cannot ${operation} while the Codex runtime is ${this.state}.`,
    );
  }
}

function observeExit(child: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolve) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
      if (child.pid === undefined) resolve({ code: null, signal: null, error });
    });
    child.once("close", (code, signal) => {
      resolve({ code, signal, ...(spawnError ? { error: spawnError } : {}) });
    });
  });
}

async function settledValue<T>(promise: Promise<T>): Promise<T | undefined> {
  const marker = Symbol("pending");
  const value = await Promise.race([promise, Promise.resolve(marker)]);
  return value === marker ? undefined : value;
}

async function settlesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void onTimeout().finally(() => {
            reject(new Error("The process operation timed out."));
          });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function childExitedBeforeReady(
  role: ProcessRole,
  exit: ProcessExit,
): CodexProcessRuntimeError {
  return new CodexProcessRuntimeError(
    "startup_failed",
    `Codex ${role} exited before becoming ready.`,
    {
      cause:
        exit.error ??
        new Error(
          `Process exit: code=${String(exit.code)} signal=${String(exit.signal)}`,
        ),
    },
  );
}

function unavailableError(cause: unknown): CodexProcessRuntimeError {
  return new CodexProcessRuntimeError(
    "unavailable",
    "The Codex executable is unavailable.",
    { cause },
  );
}

function normalizeRuntimeError(
  cause: unknown,
  code: CodexProcessRuntimeErrorCode,
  message: string,
): CodexProcessRuntimeError {
  return cause instanceof CodexProcessRuntimeError
    ? cause
    : new CodexProcessRuntimeError(code, message, { cause });
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0)
    throw new TypeError(`${name} must be non-empty`);
}

function requirePositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function isFileSystemError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
