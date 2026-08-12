import type {
  AttemptFailure,
  AttemptRecord,
  ExternalEventRecord,
  NormalVisitRecord,
  ParallelVisitRecord,
  RunRecord,
  TaskRecord,
  VisitRecord,
} from "../../domain/execution/run.js";
import {
  calculateParallelOutcome,
  evaluateWorkflowDeadline,
  projectWorkspaceForTask,
  terminalStatus,
  workspaceMode,
} from "../../domain/execution/run.js";
import type {
  AgentWorkDefinition,
  EffectiveExecutionDefinition,
  NormalStateDefinition,
  ParallelStateDefinition,
} from "../../ports/project-definitions.js";
import { ProjectWorkspaceError } from "../../ports/project-workspaces.js";
import type {
  ControllerSession,
  RunRepository,
  ValidatedNormalResult,
} from "../../ports/run-repository.js";
import {
  RunCancellationRequestedError,
  RunNotResumableError,
} from "../../ports/run-repository.js";
import type {
  RecoveryObservation,
  TaskExecution,
  TaskExecutor,
  TaskLaunch,
} from "../../ports/task-executor.js";
import {
  ControllerDetachedError,
  detached,
  throwIfDetached,
} from "../services/controller-detachment.js";
import {
  type ProjectWorkspaceCoordinator,
  requireWorkspaceCoordinator,
  workspaceFailure,
} from "../services/project-workspace-coordinator.js";

export interface RecoverWorkflowRequest {
  projectRoot: string;
  runId: string;
  controllerId: string;
  signal?: AbortSignal;
}

export type RecoveryWait = (milliseconds: number) => Promise<void>;

interface ControlledRun {
  run: RunRecord;
  definition: EffectiveExecutionDefinition;
  controllerId: string;
  fencingToken: number;
  signal?: AbortSignal;
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
    private readonly workspaceCoordinator?: ProjectWorkspaceCoordinator,
  ) {}

  async recover(request: RecoverWorkflowRequest): Promise<RunRecord> {
    if (!this.runs.load)
      throw new Error("Run repository does not support run loading");
    if (!this.runs.acquireControl)
      throw new Error("Run repository does not support lease acquisition");
    const recovered = await this.runs.load(request.projectRoot, request.runId);
    if (recovered.run.status !== "running")
      throw new RunNotResumableError(
        `Run ${request.runId} is already ${recovered.run.status}`,
      );
    let acquired: ControllerSession;
    try {
      acquired = await this.runs.acquireControl(
        request.projectRoot,
        request.runId,
        request.controllerId,
        this.timestamp(),
      );
    } catch (error) {
      if (error instanceof RunCancellationRequestedError) return error.run;
      throw error;
    }
    const controlled: ControlledRun = {
      run: acquired.run,
      definition: recovered.definition,
      controllerId: request.controllerId,
      fencingToken: acquired.fencingToken,
      signal: request.signal,
    };
    controlled.run.workspace ??= {
      mode: recovered.definition.workspaceMode,
      worktrees: [],
    };
    try {
      if (workspaceMode(controlled.run) === "worktree")
        try {
          await this.coordinator().prepareMain(
            controlled.run,
            () => this.timestamp(),
            () => this.persist(controlled),
          );
        } catch (error) {
          await this.failRun(controlled, workspaceFailure(error));
          return controlled.run;
        }
      controlled.run = await this.continue(controlled);
    } catch (error) {
      if (error instanceof RunCancellationRequestedError)
        controlled.run = error.run;
      else if (error instanceof ProjectWorkspaceError)
        await this.failRun(controlled, workspaceFailure(error));
      else throw error;
    }
    if (this.runs.releaseControl && controlled.run.controllerLease)
      try {
        controlled.run = await this.runs.releaseControl(
          controlled.run,
          controlled.controllerId,
          controlled.fencingToken,
          this.timestamp(),
        );
      } catch (error) {
        if (error instanceof RunCancellationRequestedError)
          controlled.run = error.run;
        else throw error;
      }
    return controlled.run;
  }

  private async continue(controlled: ControlledRun): Promise<RunRecord> {
    while (controlled.run.status === "running") {
      throwIfDetached(controlled.signal);
      if (
        !evaluateWorkflowDeadline(controlled.run.deadlineAt, this.timestamp())
          .allowed
      ) {
        await this.expireWorkflow(controlled);
        return controlled.run;
      }
      const visit = await this.currentVisit(controlled);
      if (controlled.run.status !== "running") return controlled.run;
      if (visit.outcome !== undefined && visit.target !== undefined) {
        if (this.terminal(visit.target)) {
          if (workspaceMode(controlled.run) === "worktree")
            await this.coordinator().observeAll(controlled.run, () =>
              this.timestamp(),
            );
          controlled.run.terminalTarget = visit.target;
          controlled.run.status = terminalStatus(visit.target);
          await this.persist(controlled);
          return controlled.run;
        }
        await this.createVisit(controlled, visit.target);
        continue;
      }
      const state = controlled.definition.states[visit.stateId];
      if (
        visit.type === "parallel" &&
        state.type === "parallel" &&
        !visit.contextPath &&
        workspaceMode(controlled.run) === "worktree"
      )
        try {
          await this.coordinator().prepareParallel(
            controlled.run,
            visit,
            () => this.timestamp(),
            () => this.persist(controlled),
          );
        } catch (error) {
          await this.failRun(controlled, workspaceFailure(error));
          return controlled.run;
        }
      if (!visit.contextPath) {
        visit.contextPath = await this.runs.prepareVisitContext(controlled.run);
        await this.persist(controlled);
      }
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
              workspace:
                workspaceMode(controlled.run) === "worktree"
                  ? { mode: "worktree", path: "" }
                  : { mode: "direct", path: controlled.run.projectRoot },
            })),
          };
    controlled.run.visits.push(visit);
    this.event(controlled.run, "state_entered", {
      stateId,
      visitNumber: number,
    });
    const queuedTasks = visit.type === "agent" ? [visit.task] : visit.tasks;
    for (const task of queuedTasks)
      this.event(controlled.run, "task_queued", {
        stateId,
        visitNumber: number,
        taskId: task.id,
        recovered: true,
      });
    if (
      visit.type === "parallel" &&
      workspaceMode(controlled.run) === "worktree"
    )
      try {
        await this.coordinator().prepareParallel(
          controlled.run,
          visit,
          () => this.timestamp(),
          () => this.persist(controlled),
        );
      } catch (error) {
        await this.failRun(controlled, workspaceFailure(error));
        return visit;
      }
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
    if (workspaceMode(controlled.run) === "worktree")
      await this.coordinator().observeTask(
        controlled.run,
        visit,
        visit.task,
        () => this.timestamp(),
        "recovered_task_settled",
      );
    this.event(controlled.run, "attempt_succeeded", {
      stateId: visit.stateId,
      visitNumber: visit.number,
      taskId: visit.task.id,
      identity: recovered.attempt.id,
      attemptNumber: recovered.attempt.number,
      outcome: recovered.result.outcome,
      documents: documents.map((document) => document.internalPath),
      recovered: true,
    });
    visit.outcome = recovered.result.outcome;
    visit.target = target;
    this.appendDocuments(controlled.run, documents);
    this.documentEvents(controlled.run, documents);
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
        this.event(controlled.run, "attempt_failed", {
          stateId: visit.stateId,
          visitNumber: visit.number,
          taskId: task.id,
          identity: result.attempt.id,
          attemptNumber: result.attempt.number,
          failure: task.failure,
          recovered: true,
        });
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
        this.event(controlled.run, "attempt_succeeded", {
          stateId: visit.stateId,
          visitNumber: visit.number,
          taskId: task.id,
          identity: result.attempt.id,
          attemptNumber: result.attempt.number,
          outcome: "succeeded",
          documents: documents.map((document) => document.internalPath),
          recovered: true,
        });
      }
      if (workspaceMode(controlled.run) === "worktree")
        await this.coordinator().observeTask(
          controlled.run,
          visit,
          task,
          () => this.timestamp(),
          "recovered_task_settled",
        );
      await this.persist(controlled);
    }
    const outcome = calculateParallelOutcome(visit.tasks);
    visit.outcome = outcome;
    visit.target = state.outcomes[outcome];
    this.appendDocuments(
      controlled.run,
      visit.tasks.flatMap((task) => task.documents),
    );
    this.documentEvents(
      controlled.run,
      visit.tasks.flatMap((task) => task.documents),
    );
    this.event(controlled.run, "parallel_join_committed", {
      stateId: visit.stateId,
      visitNumber: visit.number,
      outcome,
      tasks: visit.tasks.map((task) => ({
        id: task.id,
        status: task.status,
        attempts: task.attempts.length,
        ...(task.failure ? { finalError: task.failure } : {}),
      })),
      recovered: true,
    });
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
    throwIfDetached(controlled.signal);
    const projectWorkspace = projectWorkspaceForTask(
      controlled.run,
      visit,
      task,
    );
    let attempt = task.attempts.at(-1);
    if (attempt && !attempt.deadlineAt) {
      const startedEvent = controlled.run.events.find(
        (event) =>
          (event.type === "attempt_started" ||
            event.type === "attempt_launching") &&
          event.data.identity === attempt?.id,
      );
      attempt.startedAt ??= startedEvent?.at;
      if (attempt.startedAt)
        attempt.deadlineAt = new Date(
          Date.parse(attempt.startedAt) + work.policies.attemptTimeoutMs,
        ).toISOString();
    }
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
      attempt.startedAt = this.timestamp();
      attempt.deadlineAt = new Date(
        Date.parse(attempt.startedAt) + work.policies.attemptTimeoutMs,
      ).toISOString();
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
      this.event(controlled.run, "task_scheduled", {
        stateId: visit.stateId,
        visitNumber: visit.number,
        taskId: task.id,
        attemptNumber: number,
        identity: attempt.id,
        recovered: true,
      });
      await this.persist(controlled);
    }
    if (
      attempt.deadlineAt &&
      Date.parse(this.timestamp()) >= Date.parse(attempt.deadlineAt)
    )
      return this.expireAttempt(controlled, attempt, projectWorkspace);
    const observation = await this.observe(
      controlled,
      attempt,
      projectWorkspace,
    );
    for (const externalEvent of observation.status === "not_found"
      ? []
      : (observation.events ?? []))
      this.recordExternalEvent(controlled.run, attempt, externalEvent);
    if (observation.status !== "not_found" && observation.events?.length)
      await this.persist(controlled);
    if (observation.status === "not_found")
      return this.launchRecovered(
        controlled,
        visit,
        task,
        attempt,
        work,
        allowedOutcomes,
        projectWorkspace,
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
      const settled = await this.waitForExisting(
        controlled,
        attempt,
        work,
        projectWorkspace,
      );
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
    projectWorkspace: string,
  ): Promise<RecoveredTaskResult> {
    const launch = this.launch(controlled, attempt, work, projectWorkspace);
    let execution: TaskExecution;
    try {
      const launched = this.executor.execute(launch, async (references) => {
        attempt.executor = references;
        attempt.status = "running";
        await this.persist(controlled);
      });
      execution = await Promise.race([
        launched,
        ...(controlled.signal ? [detached(controlled.signal)] : []),
      ]);
    } catch (error) {
      if (error instanceof ControllerDetachedError) throw error;
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
    projectWorkspace: string,
  ): Promise<RecoveredTaskResult | { status: "completed" }> {
    while (true) {
      const remaining = Math.min(
        Date.parse(controlled.run.deadlineAt) - this.now().getTime(),
        attempt.deadlineAt
          ? Date.parse(attempt.deadlineAt) - this.now().getTime()
          : work.policies.attemptTimeoutMs,
      );
      if (remaining <= 0) {
        if (this.now().getTime() >= Date.parse(controlled.run.deadlineAt)) {
          await this.expireWorkflow(controlled);
          return {
            status: "failed",
            failure: controlled.run.failure!,
            attempt,
          };
        }
        return this.expireAttempt(controlled, attempt, projectWorkspace);
      }
      const leaseHeartbeatMs = Math.max(
        1,
        Math.floor((controlled.run.controllerLease?.durationMs ?? 200) / 2),
      );
      const delay = Math.min(100, leaseHeartbeatMs, remaining);
      await this.wait(delay);
      throwIfDetached(controlled.signal);
      const observation = await this.observe(
        controlled,
        attempt,
        projectWorkspace,
      );
      for (const externalEvent of observation.status === "not_found"
        ? []
        : (observation.events ?? []))
        this.recordExternalEvent(controlled.run, attempt, externalEvent);
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
      message: "Previously active external execution disappeared",
    };
    await this.persist(controlled);
    return { status: "unsafe", failure: attempt.failure, attempt };
  }

  private async observe(
    controlled: ControlledRun,
    attempt: AttemptRecord,
    projectWorkspace: string,
  ): Promise<RecoveryObservation> {
    if (!this.executor.recover)
      throw new Error("Configured task executor does not support recovery");
    return this.executor.recover(
      attempt.id,
      attempt.executor,
      projectWorkspace,
    );
  }

  private recordExternalEvent(
    run: RunRecord,
    attempt: AttemptRecord,
    externalEvent: ExternalEventRecord,
  ): void {
    attempt.externalEvents ??= [];
    const existing = attempt.externalEvents.find(
      (candidate) => candidate.id === externalEvent.id,
    );
    if (existing?.status === externalEvent.status) {
      Object.assign(existing, externalEvent);
      return;
    }
    if (existing) Object.assign(existing, externalEvent);
    else attempt.externalEvents.push(externalEvent);
    const visit = run.visits.find((candidate) =>
      (candidate.type === "agent" ? [candidate.task] : candidate.tasks).some(
        (task) => task.attempts.includes(attempt),
      ),
    );
    const task = visit
      ? (visit.type === "agent" ? [visit.task] : visit.tasks).find(
          (candidate) => candidate.attempts.includes(attempt),
        )
      : undefined;
    this.event(
      run,
      `orca_${externalEvent.type}_${externalEvent.status === "resolved" ? "resolved" : "observed"}`,
      {
        stateId: visit?.stateId,
        visitNumber: visit?.number,
        taskId: task?.id,
        attemptNumber: attempt.number,
        identity: attempt.id,
        externalEventId: externalEvent.id,
        status: externalEvent.status,
        ...(externalEvent.message === undefined
          ? {}
          : { message: externalEvent.message }),
      },
    );
  }

  private async expireAttempt(
    controlled: ControlledRun,
    attempt: AttemptRecord,
    projectWorkspace: string,
  ): Promise<RecoveredTaskResult> {
    attempt.status = "timing_out";
    const failure = {
      code: "attempt_timeout",
      message: `Attempt deadline ${attempt.deadlineAt} expired while detached`,
    };
    if (!attempt.executor) {
      attempt.status = "failed";
      attempt.failure = {
        code: "external_execution_uncertain",
        message: "Expired attempt has no confirmed external identity",
      };
      await this.persist(controlled);
      return { status: "unsafe", failure: attempt.failure, attempt };
    }
    attempt.reconciliation = {
      cancellationRequestedAt: this.timestamp(),
      observations: [],
    };
    await this.persist(controlled);
    try {
      await this.executor.cancel(attempt.executor, projectWorkspace);
      const completedAt = this.timestamp();
      attempt.reconciliation.cancellationCommandCompletedAt = completedAt;
      this.event(controlled.run, "attempt_cancellation_command_completed", {
        identity: attempt.id,
        dispatchId: attempt.executor.dispatchId,
        cause: "attempt_timeout",
      });
      await this.persist(controlled);
    } catch {
      // Reconciliation below is authoritative.
    }
    const status = await this.executor.reconcile(
      attempt.executor,
      projectWorkspace,
    );
    const observedAt = this.timestamp();
    attempt.reconciliation.observations.push({ status, at: observedAt });
    attempt.externalStatus = status;
    if (status !== "stopped") {
      attempt.failure = {
        code: "external_execution_uncertain",
        message: "Timed-out external execution is not confirmed stopped",
      };
      await this.persist(controlled);
      return { status: "unsafe", failure: attempt.failure, attempt };
    }
    attempt.reconciliation.confirmedStoppedAt = observedAt;
    attempt.status = "failed";
    attempt.failure = failure;
    await this.persist(controlled);
    return { status: "failed", failure, attempt };
  }

  private async expireWorkflow(controlled: ControlledRun): Promise<void> {
    for (const visit of controlled.run.visits) {
      const tasks = visit.type === "agent" ? [visit.task] : visit.tasks;
      for (const task of tasks) {
        const attempt = task.attempts.at(-1);
        if (
          !attempt?.executor ||
          attempt.status === "succeeded" ||
          attempt.status === "failed"
        )
          continue;
        const projectWorkspace = projectWorkspaceForTask(
          controlled.run,
          visit,
          task,
        );
        try {
          await this.executor.cancel(attempt.executor, projectWorkspace);
        } catch {
          // The run still ends for the expired global deadline.
        }
        try {
          attempt.externalStatus = await this.executor.reconcile(
            attempt.executor,
            projectWorkspace,
          );
        } catch {
          attempt.externalStatus = "unknown";
        }
      }
    }
    await this.failRun(controlled, {
      code: "workflow_timeout",
      message: `Workflow deadline ${controlled.run.deadlineAt} expired while detached`,
    });
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
    requestedFailure: AttemptFailure,
  ): Promise<void> {
    let failure = requestedFailure;
    try {
      if (workspaceMode(controlled.run) === "worktree")
        await this.coordinator().observeAll(controlled.run, () =>
          this.timestamp(),
        );
    } catch (error) {
      failure = workspaceFailure(error);
    }
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

  private documentEvents(
    run: RunRecord,
    documents: RunRecord["documents"],
  ): void {
    for (const document of documents)
      if (
        !run.events.some(
          (event) =>
            event.type === "document_committed" &&
            event.data.internalPath === document.internalPath,
        )
      )
        this.event(run, "document_committed", {
          stateId: document.stateId,
          visitNumber: document.visitNumber,
          taskId: document.taskId,
          name: document.name,
          internalPath: document.internalPath,
          sha256: document.sha256,
          recovered: true,
        });
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
    controlled: ControlledRun,
    attempt: AttemptRecord,
    work: AgentWorkDefinition,
    projectWorkspace: string,
  ): TaskLaunch {
    return {
      identity: attempt.id,
      projectWorkspace,
      contextPath: attempt.contextPath,
      outputDirectory: attempt.outputDirectory,
      resultPath: attempt.resultPath,
      instructions: work.agent.instructions,
      prompt: work.prompt,
      model: work.agent.model,
      timeoutMs: work.policies.attemptTimeoutMs,
      attemptNumber: attempt.number,
      signal: controlled.signal,
    };
  }

  private terminal(target: string): target is "$succeeded" | "$failed" {
    return target === "$succeeded" || target === "$failed";
  }

  private coordinator(): ProjectWorkspaceCoordinator {
    return requireWorkspaceCoordinator(this.workspaceCoordinator);
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
