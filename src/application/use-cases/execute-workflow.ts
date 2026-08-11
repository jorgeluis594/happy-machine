import type {
  AttemptRecord,
  RunRecord,
  VisitRecord,
} from "../../domain/execution/run.js";
import { terminalStatus } from "../../domain/execution/run.js";
import type { ProjectDefinitions } from "../../ports/project-definitions.js";
import type { RunRepository } from "../../ports/run-repository.js";
import type { TaskExecutor } from "../../ports/task-executor.js";

export interface ExecuteWorkflowRequest {
  workflowPath: string;
  currentDirectory: string;
  inputPaths?: readonly string[];
  onRunAllocated(runId: string): void;
}

export class ExecuteWorkflow {
  constructor(
    private readonly definitions: ProjectDefinitions,
    private readonly runs: RunRepository,
    private readonly executor: TaskExecutor,
    private readonly now: () => Date,
    private readonly makeId: () => string,
  ) {}

  async execute(request: ExecuteWorkflowRequest): Promise<RunRecord> {
    const definition = await this.definitions.load(
      request.workflowPath,
      request.currentDirectory,
      request.inputPaths ?? [],
    );
    const timestamp = () => this.now().toISOString();
    const runId = `run_${this.makeId()}`;
    const createdSnapshot = await this.runs.createSnapshot({
      runId,
      projectRoot: definition.projectRoot,
      workflowId: definition.workflowId,
      source: definition.snapshotSource,
    });
    const run: RunRecord = {
      id: runId,
      workflowId: definition.workflowId,
      workflowPath: definition.workflowPath,
      projectRoot: definition.projectRoot,
      definitionSnapshot: createdSnapshot.record,
      status: "running",
      createdAt: timestamp(),
      visits: [],
      documents: [],
      events: [],
    };
    this.event(run, "run_created", timestamp(), {
      workflowId: definition.workflowId,
      definitionSnapshotIdentity: createdSnapshot.record.identity,
    });
    await this.runs.save(run);
    request.onRunAllocated(run.id);

    let stateId = createdSnapshot.definition.initialState;
    while (true) {
      const state = createdSnapshot.definition.states[stateId];
      if (state.type !== "agent")
        throw new Error("This release cannot execute a parallel state");
      const visitNumber =
        run.visits.filter((candidate) => candidate.stateId === state.id)
          .length + 1;
      const taskId = `${state.id}-task`;
      const visit: VisitRecord = {
        stateId: state.id,
        number: visitNumber,
        contextPath: "",
        task: { id: taskId, attempts: [] },
      };
      run.visits.push(visit);
      this.event(run, "state_entered", timestamp(), {
        stateId: state.id,
        visitNumber,
      });
      visit.contextPath = await this.runs.prepareVisitContext(run);
      await this.runs.save(run);
      const identity = `${run.id}:${state.id}:${visitNumber}:${taskId}:1`;
      const attempt: AttemptRecord = {
        id: identity,
        number: 1,
        status: "launching",
        controlWorkspace: "",
        contextPath: "",
        outputDirectory: "",
        resultPath: "",
        logs: { stdout: "", stderr: "" },
        documents: [],
      };
      visit.task.attempts.push(attempt);
      const paths = await this.runs.prepareAttempt(run);
      Object.assign(attempt, paths);
      this.event(run, "attempt_launching", timestamp(), { identity });
      await this.runs.save(run);

      try {
        const execution = await this.executor.execute(
          {
            identity,
            projectWorkspace: definition.projectRoot,
            ...paths,
            instructions: state.agent.instructions,
            prompt: state.prompt,
            model: state.agent.model,
            timeoutMs: state.policies.attemptTimeoutMs,
            attemptNumber: 1,
          },
          async (references) => {
            attempt.executor = references;
            attempt.status = "running";
            this.event(run, "attempt_started", timestamp(), {
              identity,
              ...references,
            });
            await this.runs.save(run);
          },
        );
        attempt.executor = execution.references;
        attempt.logs = execution.logs;
        const result = await this.runs.readResult(
          paths.resultPath,
          paths.outputDirectory,
          Object.keys(state.outcomes),
        );
        attempt.outcome = result.outcome;
        attempt.status = "succeeded";
        visit.outcome = result.outcome;
        const target = state.outcomes[result.outcome];
        if (!target)
          throw new Error(
            `No transition configured for outcome ${result.outcome}`,
          );
        visit.target = target;
        attempt.documents = await this.runs.commitDocuments(
          run,
          paths.outputDirectory,
          result.documents,
        );
        run.documents.push(...attempt.documents);
        this.event(run, "attempt_succeeded", timestamp(), {
          identity,
          outcome: result.outcome,
          documents: attempt.documents.map((document) => document.internalPath),
        });
        this.event(run, "transition_committed", timestamp(), {
          stateId: state.id,
          visitNumber,
          outcome: result.outcome,
          target,
        });
        if (target === "$succeeded" || target === "$failed") {
          run.terminalTarget = target;
          run.status = terminalStatus(target);
          this.event(run, "run_terminal", timestamp(), {
            status: run.status,
            target: visit.target,
          });
        }
        await this.runs.save(run);
        if (target === "$succeeded" || target === "$failed") return run;
        stateId = target;
      } catch (error) {
        attempt.status = "failed";
        run.status = "failed";
        this.event(run, "run_terminal", timestamp(), {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        await this.runs.save(run);
        throw error;
      }
    }
  }

  private event(
    run: RunRecord,
    type: string,
    at: string,
    data: Record<string, unknown>,
  ): void {
    run.events.push({ sequence: run.events.length + 1, type, at, data });
  }
}
