import type { RunStatus } from "../domain/execution/run.js";

export type ChildControllerTerminalStatus = Extract<
  RunStatus,
  "succeeded" | "failed" | "canceled"
>;

export interface ChildControllerProvenance {
  projectRoot: string;
  childRunId: string;
  parentRunId?: string;
  stateId?: string;
  visitNumber?: number;
  taskId?: string;
}

export interface ChildControllerExternalIdentity {
  executionId: string;
  provenance: ChildControllerProvenance;
}

export interface ChildControllerDiagnostics {
  stdoutPath: string;
  stderrPath: string;
}

export interface ChildControllerExecution {
  identity: ChildControllerExternalIdentity;
  diagnostics: ChildControllerDiagnostics;
}

export type ChildControllerObservation =
  | {
      status: "active";
      identity: ChildControllerExternalIdentity;
      diagnostics: ChildControllerDiagnostics;
    }
  | {
      status: "terminal";
      identity: ChildControllerExternalIdentity;
      terminalStatus: ChildControllerTerminalStatus;
      diagnostics: ChildControllerDiagnostics;
    }
  | { status: "not_started"; provenance: ChildControllerProvenance }
  | {
      status: "start_unknown" | "stop_unknown" | "irreconcilable";
      identity: ChildControllerExternalIdentity;
      diagnostics: ChildControllerDiagnostics;
      message: string;
    };

export interface ChildControllerLaunch {
  projectRoot: string;
  childRunId: string;
  provenance: ChildControllerProvenance;
}

export interface ChildControllerRecovery {
  projectRoot: string;
  provenance: ChildControllerProvenance;
}

export interface ChildControllerCancellation {
  projectRoot: string;
  identity: ChildControllerExternalIdentity;
}

export interface ChildControllerReconciliation {
  projectRoot: string;
  identity: ChildControllerExternalIdentity;
}

export class WorkflowControllerUncertaintyError extends Error {
  constructor(
    readonly uncertainty: "start_unknown" | "stop_unknown" | "irreconcilable",
    message: string,
  ) {
    super(message);
  }
}

export interface WorkflowController {
  start(request: ChildControllerLaunch): Promise<ChildControllerExecution>;
  recover(
    request: ChildControllerRecovery,
  ): Promise<ChildControllerObservation>;
  cancel(request: ChildControllerCancellation): Promise<void>;
  reconcile(
    request: ChildControllerReconciliation,
  ): Promise<ChildControllerObservation>;
}
