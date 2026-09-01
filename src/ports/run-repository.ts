import type {
  DefinitionSnapshotRecord,
  DocumentRecord,
  JsonValue,
  StructuredOutputRecord,
  TaskRecord,
  VisitRecord,
  RunRecord,
} from "../domain/execution/run.js";
import type {
  ParentRunReference,
  WorkflowTaskCoordinate,
  WorkflowTaskEnvelope,
} from "../domain/execution/workflow-task.js";
import type {
  DefinitionSnapshotSource,
  EffectiveExecutionDefinition,
} from "./project-definitions.js";

export interface RecoveredRun {
  run: RunRecord;
  definition: EffectiveExecutionDefinition;
}

export interface ControllerSession {
  run: RunRecord;
  fencingToken: number;
}

export type CancellationRequestResult =
  | { accepted: false; run: RunRecord }
  | { accepted: true; run: RunRecord; fencingToken: number };

export class RunAlreadyControlledError extends Error {
  readonly code = "run_already_controlled";
}

export class ControllerLeaseLostError extends Error {
  readonly code = "controller_lease_lost";
}

export class RunNotResumableError extends Error {
  readonly code = "run_not_resumable";
}

export class RunCancellationRequestedError extends Error {
  readonly code = "run_cancellation_requested";

  constructor(readonly run: RunRecord) {
    super(`Run ${run.id} is ${run.status}`);
  }
}

export interface AttemptPaths {
  controlWorkspace: string;
  contextPath: string;
  outputDirectory: string;
  resultPath: string;
}

export interface SnapshotCreationRequest {
  runId: string;
  projectRoot: string;
  workflowId: string;
  source: DefinitionSnapshotSource;
}

export interface SnapshotCreationResult {
  record: DefinitionSnapshotRecord;
  definition: EffectiveExecutionDefinition;
}

export interface ChildRunReservationRequest {
  projectRoot: string;
  parentRunId: string;
  coordinate: WorkflowTaskCoordinate;
  workflowId: string;
  workflowSnapshotIdentity: string;
  resolvedWith: Record<string, JsonValue>;
  provenance?: ParentRunReference;
}

export interface ReservedChildRun {
  childRunId: string;
  coordinate: WorkflowTaskCoordinate;
  workflowId: string;
  workflowSnapshotIdentity: string;
  resolvedWith: Record<string, JsonValue>;
}

export interface ChildRunCreationRequest extends ChildRunReservationRequest {
  workflowDefinition: EffectiveExecutionDefinition;
  parentSnapshot: DefinitionSnapshotRecord;
  createdAt: string;
  deadlineAt: string;
}

export interface EvaluationContextRecord {
  path: string;
  sha256: string;
}

export interface WorkflowTaskResultCommitRequest {
  parent: RunRecord;
  coordinate: WorkflowTaskCoordinate;
  attempt: import("../domain/execution/run.js").AttemptRecord;
  envelope: WorkflowTaskEnvelope;
  documents: DocumentRecord[];
  events: RunRecord["events"];
}

export interface ValidatedNormalResult {
  outcome: string;
  documents: string[];
  error?: JsonValue;
  outputs?: Record<string, JsonValue>;
}

export type ResultValidationCode =
  | "result_missing_or_invalid"
  | "outcome_invalid"
  | "documents_invalid"
  | "structured_outputs_invalid";

export class ResultValidationError extends Error {
  constructor(
    readonly code: ResultValidationCode,
    message: string,
  ) {
    super(message);
  }
}

export interface RunRepository {
  createSnapshot(
    request: SnapshotCreationRequest,
  ): Promise<SnapshotCreationResult>;
  load?(projectRoot: string, runId: string): Promise<RecoveredRun>;
  discoverProjectRoot?(currentDirectory: string): Promise<string>;
  list?(projectRoot: string): Promise<RunRecord[]>;
  claimCleanupPrompt?(
    projectRoot: string,
    runId: string,
    shownAt: string,
  ): Promise<RunRecord | undefined>;
  acquireControl?(
    projectRoot: string,
    runId: string,
    controllerId: string,
    observedAt: string,
  ): Promise<ControllerSession>;
  requestCancellation?(
    projectRoot: string,
    runId: string,
    controllerId: string,
    requestedAt: string,
  ): Promise<CancellationRequestResult>;
  renewControl?(
    run: RunRecord,
    controllerId: string,
    fencingToken: number,
    observedAt: string,
  ): Promise<ControllerSession>;
  saveControlled?(
    run: RunRecord,
    controllerId: string,
    fencingToken: number,
  ): Promise<void>;
  releaseControl?(
    run: RunRecord,
    controllerId: string,
    fencingToken: number,
    observedAt: string,
  ): Promise<RunRecord>;
  save(run: RunRecord): Promise<void>;
  reserveChildRun?(
    request: ChildRunReservationRequest,
  ): Promise<ReservedChildRun>;
  getOrCreateChildRun?(request: ChildRunCreationRequest): Promise<RunRecord>;
  loadChildRun?(projectRoot: string, childRunId: string): Promise<RecoveredRun>;
  stageWorkflowTaskEvaluationContext?(request: {
    parent: RunRecord;
    coordinate: WorkflowTaskCoordinate;
    resolvedWith: Record<string, JsonValue>;
    childRunId: string;
  }): Promise<EvaluationContextRecord>;
  commitWorkflowTaskResult?(
    request: WorkflowTaskResultCommitRequest,
  ): Promise<RunRecord>;
  prepareVisitContext(run: RunRecord): Promise<string>;
  prepareAttempt(
    run: RunRecord,
    visit: VisitRecord,
    task: TaskRecord,
    attemptNumber: number,
  ): Promise<AttemptPaths>;
  readResult(
    resultPath: string,
    outputDirectory: string,
    allowedOutcomes: readonly string[],
    outputDefinitions?: import("./project-definitions.js").NormalStateDefinition["produces"],
  ): Promise<ValidatedNormalResult>;
  stageStructuredOutputs?(
    run: RunRecord,
    visit: VisitRecord,
    outputs: Readonly<Record<string, JsonValue>>,
  ): Promise<StructuredOutputRecord[]>;
  readStructuredOutput?(output: StructuredOutputRecord): Promise<JsonValue>;
  stageDocuments(
    run: RunRecord,
    visit: VisitRecord,
    task: TaskRecord,
    outputDirectory: string,
    names: readonly string[],
  ): Promise<DocumentRecord[]>;
}
