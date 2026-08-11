import type { RunRecord } from "../domain/execution/run.js";

export interface AttemptPaths {
  controlWorkspace: string;
  contextPath: string;
  outputDirectory: string;
  resultPath: string;
}

export interface RunRepository {
  save(run: RunRecord): Promise<void>;
  prepareAttempt(
    run: RunRecord,
    instructions: string,
    prompt: string,
  ): Promise<AttemptPaths>;
  readResult(
    resultPath: string,
    outputDirectory: string,
    allowedOutcomes: readonly string[],
  ): Promise<{ outcome: string; documents: string[] }>;
}
