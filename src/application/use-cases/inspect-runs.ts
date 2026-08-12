import type { RunRecord } from "../../domain/execution/run.js";
import { leaseIsValid } from "../../domain/execution/run.js";
import type { RunRepository } from "../../ports/run-repository.js";

export interface RunStatusResult {
  run: RunRecord;
  observedAt: string;
  leaseValid: boolean;
}

export interface ProjectHistoryResult {
  projectRoot: string;
  runs: RunRecord[];
}

export interface RunHistoryResult {
  run: RunRecord;
}

export class InspectRuns {
  constructor(
    private readonly runs: RunRepository,
    private readonly now: () => Date,
  ) {}

  async status(
    currentDirectory: string,
    runId: string,
  ): Promise<RunStatusResult> {
    const { run } = await this.load(currentDirectory, runId);
    const observedAt = this.now().toISOString();
    return {
      run,
      observedAt,
      leaseValid: leaseIsValid(run.controllerLease, observedAt),
    };
  }

  async history(
    currentDirectory: string,
    runId?: string,
  ): Promise<ProjectHistoryResult | RunHistoryResult> {
    if (runId) {
      const { run } = await this.load(currentDirectory, runId);
      return { run };
    }
    if (!this.runs.discoverProjectRoot || !this.runs.list)
      throw new Error("Run repository does not support project history");
    const projectRoot = await this.runs.discoverProjectRoot(currentDirectory);
    return { projectRoot, runs: await this.runs.list(projectRoot) };
  }

  private async load(
    currentDirectory: string,
    runId: string,
  ): Promise<{ projectRoot: string; run: RunRecord }> {
    if (!this.runs.discoverProjectRoot || !this.runs.load)
      throw new Error("Run repository does not support read-only inspection");
    const projectRoot = await this.runs.discoverProjectRoot(currentDirectory);
    const { run } = await this.runs.load(projectRoot, runId);
    return { projectRoot, run };
  }
}
