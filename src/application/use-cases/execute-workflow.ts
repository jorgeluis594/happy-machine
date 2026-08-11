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
    );
    const timestamp = () => this.now().toISOString();
    const run: RunRecord = {
      id: `run_${this.makeId()}`,
      workflowId: definition.workflowId,
      workflowPath: definition.workflowPath,
      projectRoot: definition.projectRoot,
      status: "running",
      createdAt: timestamp(),
      visits: [],
      events: [],
    };
    this.event(run, "run_created", timestamp(), {
      workflowId: definition.workflowId,
    });
    await this.runs.save(run);
    request.onRunAllocated(run.id);

    const state = definition.state;
    if (state.type !== "agent")
      throw new Error("This release cannot execute a parallel initial state");
    const taskId = `${state.id}-task`;
    const visit: VisitRecord = {
      stateId: state.id,
      number: 1,
      task: { id: taskId, attempts: [] },
    };
    run.visits.push(visit);
    this.event(run, "state_entered", timestamp(), {
      stateId: state.id,
      visitNumber: 1,
    });
    const identity = `${run.id}:${state.id}:1:${taskId}:1`;
    const attempt: AttemptRecord = {
      id: identity,
      number: 1,
      status: "launching",
      controlWorkspace: "",
      contextPath: "",
      outputDirectory: "",
      resultPath: "",
      logs: { stdout: "", stderr: "" },
    };
    visit.task.attempts.push(attempt);
    const paths = await this.runs.prepareAttempt(
      run,
      state.agent.instructions,
      state.prompt,
    );
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
          timeoutMs: state.attemptTimeoutMs,
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
      if (target !== "$succeeded" && target !== "$failed")
        throw new Error(
          "This release cannot execute transitions to another state",
        );
      visit.target = target;
      run.terminalTarget = target;
      run.status = terminalStatus(target);
      this.event(run, "attempt_succeeded", timestamp(), {
        identity,
        outcome: result.outcome,
      });
      this.event(run, "run_terminal", timestamp(), {
        status: run.status,
        target: visit.target,
      });
      await this.runs.save(run);
      return run;
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

  private event(
    run: RunRecord,
    type: string,
    at: string,
    data: Record<string, unknown>,
  ): void {
    run.events.push({ sequence: run.events.length + 1, type, at, data });
  }
}
