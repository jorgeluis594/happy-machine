export interface DiagnosticContext {
  runId?: string;
  stateId?: string;
  visitNumber?: number;
  taskId?: string;
  attemptNumber?: number;
  dispatchId?: string;
}

export interface DiagnosticEntry {
  at?: string;
  kind: "event" | "orca" | "transcript" | "warning";
  name: string;
  context?: DiagnosticContext;
  data?: Record<string, unknown>;
  text?: string;
  source?: "transcript" | "terminal";
  replay?: boolean;
}

export interface DiagnosticSink {
  readonly enabled: boolean;
  readonly replay: boolean;
  emit(entry: DiagnosticEntry): void;
}

export interface DiagnosticScope {
  run<T>(
    options: { enabled: boolean; replay: boolean },
    operation: () => Promise<T>,
  ): Promise<T>;
}

export const disabledDiagnostics: DiagnosticSink = {
  enabled: false,
  replay: false,
  emit: () => undefined,
};
