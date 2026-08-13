import type {
  DiagnosticEntry,
  DiagnosticScope,
  DiagnosticSink,
} from "../../../ports/diagnostics.js";

// These expressions intentionally match terminal escape/control bytes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MAX_BYTES = 2 * 1024;

export class CliDiagnostics implements DiagnosticSink, DiagnosticScope {
  enabled = false;
  replay = false;

  constructor(
    private readonly write: (message: string) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run<T>(
    options: { enabled: boolean; replay: boolean },
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = { enabled: this.enabled, replay: this.replay };
    this.enabled = options.enabled;
    this.replay = options.replay;
    try {
      return await operation();
    } finally {
      Object.assign(this, previous);
    }
  }

  emit(entry: DiagnosticEntry): void {
    if (!this.enabled) return;
    const context = entry.context ?? {};
    const labels = [
      ["run", context.runId],
      ["state", context.stateId],
      ["visit", context.visitNumber],
      ["task", context.taskId],
      ["attempt", context.attemptNumber],
      ["execution", context.executionId],
      ["dispatch", context.dispatchId],
    ]
      .filter((item) => item[1] !== undefined)
      .map(([key, value]) => `${key}=${this.clean(String(value))}`);
    if (entry.source) labels.push(`source=${entry.source}`);
    if (entry.replay) labels.push("replay=true");
    const details = entry.text ?? this.safeData(entry.data);
    const suffix = details ? ` ${this.truncate(this.clean(details))}` : "";
    this.write(
      `[${entry.at ?? this.now().toISOString()}] debug${labels.length ? ` ${labels.join(" ")}` : ""} ${this.clean(entry.kind)}=${this.clean(entry.name)}${suffix}`,
    );
  }

  private safeData(data: Record<string, unknown> | undefined): string {
    if (!data || Object.keys(data).length === 0) return "";
    try {
      return JSON.stringify(data);
    } catch {
      return "[unserializable data]";
    }
  }

  private clean(value: string): string {
    return value.replace(ANSI, "").replace(CONTROLS, "");
  }

  private truncate(value: string): string {
    const bytes = Buffer.byteLength(value);
    if (bytes <= MAX_BYTES) return value;
    let end = MAX_BYTES;
    while (end > 0 && Buffer.byteLength(value.slice(0, end)) > MAX_BYTES) end--;
    const retained = value.slice(0, end);
    return `${retained}… [${bytes - Buffer.byteLength(retained)} bytes omitted]`;
  }
}
