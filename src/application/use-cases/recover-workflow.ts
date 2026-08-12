import type {
  AttemptFailure,
  AttemptRecord,
  NormalVisitRecord,
  ParallelVisitRecord,
  RunRecord,
  TaskRecord,
  VisitRecord,
} from "../../domain/execution/run.js";
import {
  calculateParallelOutcome,
  terminalStatus,
} from "../../domain/execution/run.js";
import type {
  AgentWorkDefinition,
  EffectiveExecutionDefinition,
  NormalStateDefinition,
  ParallelStateDefinition,
} from "../../ports/project-definitions.js";
import type {
  RunRepository,
  ValidatedNormalResult,
} from "../../ports/run-repository.js";
import type {
  RecoveryObservation,
  TaskExecution,
  TaskExecutor,
  TaskLaunch,
} from "../../ports/task-executor.js";

export interface RecoverWorkflowRequest {
  projectRoot: string;
  runId: string;
  controllerId: string;
}

export type RecoveryWait = (milliseconds: number) => Promise<void>;

interface ControlledRun {
  run: RunRecord;
  definition: EffectiveExecutionDefinition;
  controllerId: string;
  fencingToken: number;
}

type RecoveredTaskResult =
  | {
      status: "succeeded";
      result: ValidatedNormalResult;
      attempt: AttemptRecord;
    }
  | { status: "failed"; failure: AttemptFailure; attempt: AttemptRecord }
  | { status: "unsafe"; failure: AttemptFailure; attempt: AttemptRecord };

export class RecoverWorkflow {
  constructor(
    private readonly runs: RunRepository,
    private readonly executor: TaskExecutor,
    private readonly now: () => Date,
    private readonly wait: RecoveryWait,
  ) {}

  async recover(request: RecoverWorkflowRequest): Promise<RunRecord> {
    if (!this.runs.load)
      throw new Error("Run repository does not support run loading");
    if (!this.runs.acquireControl)
      throw new Error("Run repository does not support lease acquisition");
    const recovered = await this.runs.load(request.projectRoot, request.runId);
    if (recovered.run.status !== "running") return recovered.run;
    const acquired = await this.runs.acquireControl(
      request.projectRoot,
      request.runId,
      request.controllerId,
      this.timestamp(),
    );
    const controlled: ControlledRun = {
      run: acquired.run,
      definition: recovered.definition,
      controllerId: request.controllerId,
      fencingToken: acquired.fencingToken,
    };
    return this.continue(controlled);
  }

  private async continue(controlled: ControlledRun): Promise<RunRecord> {
    while (controlled.run.status === "running") {
      const visit = await this.currentVisit(controlled);
      if (visit.outcome !== undefined && visit.target !== undefined) {
        if (this.terminal(visit.target)) {
          controlled.run.terminalTarget = visit.target;
          controlled.run.status = terminalStatus(visit.target);
          await this.persist(controlled);
          return controlled.run;
        }
        await this.createVisit(controlled, visit.target);
        continue;
      }
      const state = controlled.definition.states[visit.stateId];
      if (visit.type === "agent" && state.type === "agent")
        await this.recoverNormal(controlled, visit, state);
      else if (visit.type === "parallel" && state.type === "parallel")
        await this.recoverParallel(controlled, visit, state);
      else
        throw new Error("Durable visit does not match snapshotted state type");
    }
    return controlled.run;
  }

  private async currentVisit(controlled: ControlledRun): Promise<VisitRecord> {
    const current = controlled.run.visits.at(-1);
    if (current) return current;
    return this.createVisit(controlled, controlled.definition.initialState);
  }

  private async createVisit(
    controlled: ControlledRun,
    stateId: string,
  ): Promise<VisitRecord> {
    const state = controlled.definition.states[stateId];
    if (!state) throw new Error(`Unknown recovered state ${stateId}`);
    const number =
      controlled.run.visits.filter((visit) => visit.stateId === stateId)
        .length + 1;
    const visit: VisitRecord =
      state.type === "agent"
        ? {
            type: "agent",
            stateId,
            number,
            contextPath: "",
            task: { id: `${stateId}-task`, attempts: [] },
          }
        : {
            type: "parallel",
            stateId,
            number,
            contextPath: "",
            tasks: Object.values(state.tasks).map((task) => ({
              id: task.id,
              status: "queued",
              attempts: [],
              documents: [],
              workspace: { mode: "direct", path: controlled.run.projectRoot },
            })),
          };
    controlled.run.visits.push(visit);
    this.event(controlled.run, "state_entered", {
      stateId,
      visitNumber: number,
    });
    visit.contextPath = await this.runs.prepareVisitContext(controlled.run);
    await this.persist(controlled);
    return visit;
  }

  private async recoverNormal(
    controlled: ControlledRun,
    visit: NormalVisitRecord,
    state: NormalStateDefinition,
  ): Promise<void> {
    const recovered = await this.recoverTask(
      controlled,
      visit,
      visit.task,
      state,
      Object.keys(state.outcomes),
    );
    if (recovered.status !== "succeeded") {
      await this.failRun(controlled, recovered.failure);
      return;
    }
    const target = state.outcomes[recovered.result.outcome];
    if (!target)
      throw new Error(`No transition for ${recovered.result.outcome}`);
    const documents = await this.runs.stageDocuments(
      controlled.run,
      visit,
      visit.task,
      recovered.attempt.outputDirectory,
      recovered.result.documents,
    );
    recovered.attempt.status = "succeeded";
    recovered.attempt.outcome = recovered.result.outcome;
    recovered.attempt.documents = documents;
    if (recovered.result.error !== undefined)
      recovered.attempt.error = recovered.result.error;
    visit.outcome = recovered.result.outcome;
    visit.target = target;
    this.appendDocuments(controlled.run, documents);
    this.commitTransition(controlled.run, visit, target);
    await this.persist(controlled);
  }

  private async recoverParallel(
    controlled: ControlledRun,
    visit: ParallelVisitRecord,
    state: ParallelStateDefinition,
  ): Promise<void> {
    for (const task of visit.tasks) {
      if (task.status === "succeeded" || task.status === "failed") continue;
      task.status = "running";
      await this.persist(controlled);
      const result = await this.recoverTask(
        controlled,
        visit,
        task,
        state.tasks[task.id],
        ["succeeded", "failed"],
      );
      if (result.status === "unsafe") {
        await this.failRun(controlled, result.failure);
        return;
      }
      if (result.status === "failed" || result.result.outcome === "failed") {
        task.status = "failed";
        task.failure =
          result.status === "failed"
            ? result.failure
            : {
                code: "declared_failed",
                message: "Parallel task declared failed",
              };
      } else {
        const documents = await this.runs.stageDocuments(
          controlled.run,
          visit,
          task,
          result.attempt.outputDirectory,
          result.result.documents,
        );
        result.attempt.status = "succeeded";
        result.attempt.outcome = "succeeded";
        result.attempt.documents = documents;
        task.status = "succeeded";
        task.outcome = "succeeded";
        task.documents = documents;
      }
      await this.persist(controlled);
    }
    const outcome = calculateParallelOutcome(visit.tasks);
    visit.outcome = outcome;
    visit.target = state.outcomes[outcome];
    this.appendDocuments(
      controlled.run,
      visit.tasks.flatMap((task) => task.documents),
    );
    this.commitTransition(controlled.run, visit, visit.target);
    await this.persist(controlled);
  }

  private async recoverTask(
    controlled: ControlledRun,
    visit: VisitRecord,
    task: TaskRecord,
    work: AgentWorkDefinition,
    allowedOutcomes: readonly string[],
  ): Promise<RecoveredTaskResult> {
    let attempt = task.attempts.at(-1);
    if (attempt?.status === "succeeded") {
      const result = await this.runs.readResult(
        attempt.resultPath,
        attempt.outputDirectory,
        allowedOutcomes,
      );
      return { status: "succeeded", result, attempt };
    }
    if (!attempt || attempt.status === "failed") {
      if (attempt && attempt.number >= work.policies.maxAttempts)
        return {
          status: "failed",
          failure: attempt.failure ?? {
            code: "attempts_exhausted",
            message: "Recovered attempt budget is exhausted",
          },
          attempt,
        };
      const number = (attempt?.number ?? 0) + 1;
      attempt = this.newAttempt(controlled.run, visit, task, number);
      task.attempts.push(attempt);
      Object.assign(
        attempt,
        await this.runs.prepareAttempt(controlled.run, visit, task, number),
      );
      this.event(controlled.run, "attempt_launching", {
        identity: attempt.id,
        attemptNumber: number,
        recovered: true,
      });
      await this.persist(controlled);
    }
    const observation = await this.observe(controlled, attempt);
    if (observation.status === "not_found")
      return this.launchRecovered(
        controlled,
        visit,
        task,
        attempt,
        work,
        allowedOutcomes,
      );
    if (
      observation.status === "start_unknown" ||
      observation.status === "stop_unknown"
    ) {
      attempt.status = "failed";
      attempt.failure = {
        code: "external_execution_uncertain",
        message: `Recovered Orca execution remained ${observation.status}`,
      };
      attempt.executor = observation.references;
      attempt.logs = observation.logs;
      await this.persist(controlled);
      return { status: "unsafe", failure: attempt.failure, attempt };
    }
    attempt.executor = observation.references;
    attempt.logs = observation.logs;
    if (observation.status === "failed") {
      attempt.status = "failed";
      attempt.failure = {
        code: "executor_failed",
        message: "Recovered Orca execution failed",
      };
      await this.persist(controlled);
      return { status: "failed", failure: attempt.failure, attempt };
    }
    attempt.status =
      observation.status === "active" ? "running" : attempt.status;
    await this.persist(controlled);
    if (observation.status === "active") {
      const settled = await this.waitForExisting(controlled, attempt, work);
      if (settled.status !== "completed") return settled;
    }
    const result = await this.runs.readResult(
      attempt.resultPath,
      attempt.outputDirectory,
      allowedOutcomes,
    );
    return { status: "succeeded", result, attempt };
  }

  private async launchRecovered(
    controlled: ControlledRun,
    visit: VisitRecord,
    task: TaskRecord,
    attempt: AttemptRecord,
    work: AgentWorkDefinition,
    allowedOutcomes: readonly string[],
  ): Promise<RecoveredTaskResult> {
    const launch = this.launch(controlled.run, attempt, work);
    let execution: TaskExecution;
    try {
      execution = await this.executor.execute(launch, async (references) => {
        attempt.executor = references;
        attempt.status = "running";
        await this.persist(controlled);
      });
    } catch (error) {
      attempt.status = "failed";
      attempt.failure = {
        code: "executor_failed",
        message: error instanceof Error ? error.message : String(error),
      };
      await this.persist(controlled);
      return { status: "failed", failure: attempt.failure, attempt };
    }
    attempt.executor = execution.references;
    attempt.logs = execution.logs;
    await this.persist(controlled);
    const result = await this.runs.readResult(
      attempt.resultPath,
      attempt.outputDirectory,
      allowedOutcomes,
    );
    return { status: "succeeded", result, attempt };
  }

  private async waitForExisting(
    controlled: ControlledRun,
    attempt: AttemptRecord,
    work: AgentWorkDefinition,
  ): Promise<RecoveredTaskResult | { status: "completed" }> {
    let elapsed = 0;
    while (elapsed < work.policies.attemptTimeoutMs) {
      const leaseHeartbeatMs = Math.max(
        1,
        Math.floor((controlled.run.controllerLease?.durationMs ?? 200) / 2),
      );
      const delay = Math.min(
        100,
        leaseHeartbeatMs,
        work.policies.attemptTimeoutMs - elapsed,
      );
      await this.wait(delay);
      elapsed += delay;
      const observation = await this.observe(controlled, attempt);
      if (observation.status === "completed") {
        attempt.executor = observation.references;
        attempt.logs = observation.logs;
        await this.persist(controlled);
        return { status: "completed" };
      }
      if (observation.status === "failed") {
        attempt.status = "failed";
        attempt.failure = {
          code: "executor_failed",
          message: "Recovered Orca execution failed",
        };
        await this.persist(controlled);
        return { status: "failed", failure: attempt.failure, attempt };
      }
      if (observation.status === "not_found") break;
      attempt.executor = observation.references;
      attempt.logs = observation.logs;
      await this.persist(controlled);
    }
    attempt.status = "failed";
    attempt.failure = {
      code: "external_execution_uncertain",
      message: "Recovered external execution could not be confirmed safely",
    };
    await this.persist(controlled);
    return { status: "unsafe", failure: attempt.failure, attempt };
  }

  private async observe(
    controlled: ControlledRun,
    attempt: AttemptRecord,
  ): Promise<RecoveryObservation> {
    if (!this.executor.recover)
      throw new Error("Configured task executor does not support recovery");
    return this.executor.recover(
      attempt.id,
      attempt.executor,
      controlled.run.projectRoot,
    );
  }

  private async persist(controlled: ControlledRun): Promise<void> {
    if (!this.runs.saveControlled)
      throw new Error("Run repository does not support fenced persistence");
    if (!this.runs.renewControl)
      throw new Error("Run repository does not support lease renewal");
    await this.runs.saveControlled(
      controlled.run,
      controlled.controllerId,
      controlled.fencingToken,
    );
    const renewed = await this.runs.renewControl(
      controlled.run,
      controlled.controllerId,
      controlled.fencingToken,
      this.timestamp(),
    );
    controlled.run.controllerLease = renewed.run.controllerLease;
    controlled.run.events = renewed.run.events;
  }

  private async failRun(
    controlled: ControlledRun,
    failure: AttemptFailure,
  ): Promise<void> {
    controlled.run.status = "failed";
    controlled.run.failure = failure;
    this.event(controlled.run, "run_terminal", { status: "failed", failure });
    await this.persist(controlled);
  }

  private commitTransition(
    run: RunRecord,
    visit: VisitRecord,
    target: string,
  ): void {
    if (
      run.events.some(
        (event) =>
          event.type === "transition_committed" &&
          event.data.stateId === visit.stateId &&
          event.data.visitNumber === visit.number,
      )
    )
      return;
    run.transitionCount += 1;
    this.event(run, "transition_committed", {
      stateId: visit.stateId,
      visitNumber: visit.number,
      outcome: visit.outcome,
      target,
      transitionNumber: run.transitionCount,
      recovered: true,
    });
  }

  private appendDocuments(
    run: RunRecord,
    documents: RunRecord["documents"],
  ): void {
    for (const document of documents)
      if (
        !run.documents.some(
          (item) => item.internalPath === document.internalPath,
        )
      )
        run.documents.push(document);
  }

  private newAttempt(
    run: RunRecord,
    visit: VisitRecord,
    task: TaskRecord,
    number: number,
  ): AttemptRecord {
    return {
      id: `${run.id}:${visit.stateId}:${visit.number}:${task.id}:${number}`,
      number,
      status: "launching",
      controlWorkspace: "",
      contextPath: "",
      outputDirectory: "",
      resultPath: "",
      logs: { stdout: "", stderr: "" },
      documents: [],
    };
  }

  private launch(
    run: RunRecord,
    attempt: AttemptRecord,
    work: AgentWorkDefinition,
  ): TaskLaunch {
    return {
      identity: attempt.id,
      projectWorkspace: run.projectRoot,
      contextPath: attempt.contextPath,
      outputDirectory: attempt.outputDirectory,
      resultPath: attempt.resultPath,
      instructions: work.agent.instructions,
      prompt: work.prompt,
      model: work.agent.model,
      timeoutMs: work.policies.attemptTimeoutMs,
      attemptNumber: attempt.number,
    };
  }

  private terminal(target: string): target is "$succeeded" | "$failed" {
    return target === "$succeeded" || target === "$failed";
  }

  private event(
    run: RunRecord,
    type: string,
    data: Record<string, unknown>,
  ): void {
    run.events.push({
      sequence: run.events.length + 1,
      type,
      at: this.timestamp(),
      data,
    });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
