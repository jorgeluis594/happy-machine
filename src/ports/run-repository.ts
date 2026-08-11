import type {
  DefinitionSnapshotRecord,
  DocumentRecord,
  JsonValue,
  RunRecord,
} from "../domain/execution/run.js";
import type {
  DefinitionSnapshotSource,
  EffectiveExecutionDefinition,
} from "./project-definitions.js";

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

export interface RunRepository {
  createSnapshot(
    request: SnapshotCreationRequest,
  ): Promise<SnapshotCreationResult>;
  save(run: RunRecord): Promise<void>;
  prepareVisitContext(run: RunRecord): Promise<string>;
  prepareAttempt(run: RunRecord): Promise<AttemptPaths>;
  readResult(
    resultPath: string,
    outputDirectory: string,
    allowedOutcomes: readonly string[],
  ): Promise<ValidatedNormalResult>;
  stageDocuments(
    run: RunRecord,
    outputDirectory: string,
    names: readonly string[],
  ): Promise<DocumentRecord[]>;
}
