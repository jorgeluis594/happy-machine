import type {
  DefinitionSnapshotRecord,
  DocumentRecord,
  JsonValue,
  TaskRecord,
  VisitRecord,
  RunRecord,
} from "../domain/execution/run.js";
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

export class RunAlreadyControlledError extends Error {
  readonly code = "run_already_controlled";
}

export class ControllerLeaseLostError extends Error {
  readonly code = "controller_lease_lost";
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

export interface ValidatedNormalResult {
  outcome: string;
  documents: string[];
  error?: JsonValue;
}

export type ResultValidationCode =
  "result_missing_or_invalid" | "outcome_invalid" | "documents_invalid";

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
  acquireControl?(
    projectRoot: string,
    runId: string,
    controllerId: string,
    observedAt: string,
  ): Promise<ControllerSession>;
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
  ): Promise<ValidatedNormalResult>;
  stageDocuments(
    run: RunRecord,
    visit: VisitRecord,
    task: TaskRecord,
    outputDirectory: string,
    names: readonly string[],
  ): Promise<DocumentRecord[]>;
}
