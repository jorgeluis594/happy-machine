import type {
  AttemptFailure,
  AttemptRecord,
  ExecutorReferences,
  ExternalEventRecord,
  GlobalLimitEvaluation,
  NormalVisitRecord,
  ParallelVisitRecord,
  RunRecord,
  TaskRecord,
  VisitRecord,
} from "../../domain/execution/run.js";
import {
  calculateParallelOutcome,
  evaluateStateVisitLimit,
  evaluateTransitionLimit,
  evaluateWorkflowDeadline,
  projectWorkspaceForTask,
  terminalStatus,
  workspaceMode,
} from "../../domain/execution/run.js";
import type {
  AgentWorkDefinition,
  NormalStateDefinition,
  ParallelStateDefinition,
  ProjectDefinitions,
} from "../../ports/project-definitions.js";
import type { RunRepository } from "../../ports/run-repository.js";
import {
  ResultValidationError,
  RunCancellationRequestedError,
} from "../../ports/run-repository.js";
import type {
  TaskExecution,
  TaskExecutor,
  TaskLaunch,
} from "../../ports/task-executor.js";
import { TaskExecutorError } from "../../ports/task-executor.js";
import {
  disabledDiagnostics,
  type DiagnosticSink,
} from "../../ports/diagnostics.js";
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

export interface ExecuteWorkflowRequest {
  workflowPath: string;
  currentDirectory: string;
  inputPaths?: readonly string[];
  onRunAllocated(runId: string): void;
  signal?: AbortSignal;
}

export type Wait = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

type AttemptResult =
  | { kind: "completed"; execution: TaskExecution }
  | { kind: "failed"; failure: AttemptFailure }
  | { kind: "unsafe"; failure: AttemptFailure }
  | { kind: "global_limit"; failure: AttemptFailure };

type TaskFailureResult = {
  kind: "failed" | "unsafe" | "global_limit";
  failure: AttemptFailure;
};

const reconciliationPollMs = 100;

export class ExecuteWorkflow {
  constructor(
    private readonly definitions: ProjectDefinitions,
    private readonly runs: RunRepository,
    private readonly executor: TaskExecutor,
    private readonly now: () => Date,
    private readonly makeId: () => string,
    private readonly wait: Wait,
    private readonly workspaceCoordinator?: ProjectWorkspaceCoordinator,
    private readonly diagnostics: DiagnosticSink = disabledDiagnostics,
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
    const createdAt = timestamp();
    let run: RunRecord = {
      id: runId,
      workflowId: definition.workflowId,
      workflowPath: definition.workflowPath,
      projectRoot: definition.projectRoot,
      workspace: { mode: definition.workspaceMode, worktrees: [] },
      definitionSnapshot: createdSnapshot.record,
      status: "running",
      controllerStatus: "detached",
      createdAt,
      deadlineAt: new Date(
        Date.parse(createdAt) +
          createdSnapshot.definition.policies.workflowTimeoutMs,
      ).toISOString(),
      transitionCount: 0,
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
    if (workspaceMode(run) === "worktree") {
      try {
        await this.coordinator().prepareMain(run, timestamp, () =>
          this.runs.save(run),
        );
      } catch (error) {
        const failure = workspaceFailure(error);
        run.status = "failed";
        run.failure = failure;
        this.event(run, "workspace_preparation_failed", timestamp(), {
          phase: "main",
          failure,
        });
        this.event(run, "run_terminal", timestamp(), {
          status: "failed",
          failure,
        });
        await this.runs.save(run);
        return run;
      }
    }
    let controllerId: string | undefined;
    let fencingToken: number | undefined;
    if (this.runs.acquireControl) {
      controllerId = `${run.id}:initial-controller`;
      try {
        const session = await this.runs.acquireControl(
          run.projectRoot,
          run.id,
          controllerId,
          timestamp(),
        );
        run = session.run;
        fencingToken = session.fencingToken;
      } catch (error) {
        if (error instanceof RunCancellationRequestedError) return error.run;
        throw error;
      }
    }

    try {
      let stateId = createdSnapshot.definition.initialState;
      while (true) {
        throwIfDetached(request.signal);
        const state = createdSnapshot.definition.states[stateId];
        const visitNumber =
          run.visits.filter((candidate) => candidate.stateId === state.id)
            .length + 1;
        const entryFailure = await this.evaluateStateEntryLimits(
          run,
          state.id,
          visitNumber,
          createdSnapshot.definition.policies.maxStateVisits,
          timestamp,
        );
        if (entryFailure) {
          await this.terminateRun(run, entryFailure, timestamp);
          return run;
        }
        const visit: VisitRecord =
          state.type === "agent"
            ? {
                type: "agent",
                stateId: state.id,
                number: visitNumber,
                contextPath: "",
                task: { id: `${state.id}-task`, attempts: [] },
              }
            : {
                type: "parallel",
                stateId: state.id,
                number: visitNumber,
                contextPath: "",
                tasks: Object.values(state.tasks).map((task) => ({
                  id: task.id,
                  status: "queued",
                  attempts: [],
                  documents: [],
                  workspace:
                    workspaceMode(run) === "worktree"
                      ? { mode: "worktree", path: "" }
                      : { mode: "direct", path: definition.projectRoot },
                })),
              };
        run.visits.push(visit);
        this.event(run, "state_entered", timestamp(), {
          stateId: state.id,
          visitNumber,
        });
        const queuedTasks = visit.type === "agent" ? [visit.task] : visit.tasks;
        for (const task of queuedTasks)
          this.event(run, "task_queued", timestamp(), {
            stateId: state.id,
            visitNumber,
            taskId: task.id,
          });
        if (visit.type === "parallel" && workspaceMode(run) === "worktree")
          try {
            await this.coordinator().prepareParallel(
              run,
              visit,
              timestamp,
              () => this.runs.save(run),
            );
          } catch (error) {
            await this.terminateRun(run, workspaceFailure(error), timestamp);
            return run;
          }
        visit.contextPath = await this.runs.prepareVisitContext(run);
        await this.runs.save(run);

        const result =
          state.type === "agent"
            ? await this.executeNormalVisit(
                run,
                visit as NormalVisitRecord,
                state,
                timestamp,
                request.signal,
              )
            : await this.executeParallelVisit(
                run,
                visit as ParallelVisitRecord,
                state,
                timestamp,
                request.signal,
              );
        if (result.kind !== "completed") {
          await this.terminateRun(run, result.failure, timestamp);
          return run;
        }

        const { outcome, target, documents } = result;
        if (visit.type === "agent") {
          const attempt = visit.task.attempts.at(-1)!;
          attempt.outcome = outcome;
          attempt.status = "succeeded";
          if (result.diagnostic !== undefined)
            attempt.error = result.diagnostic;
          this.event(run, "attempt_succeeded", timestamp(), {
            identity: result.attempt!.id,
            outcome,
            documents: documents.map((document) => document.internalPath),
          });
          await this.runs.save(run);
        }
        const transitionFailure = await this.evaluateTransitionLimits(
          run,
          createdSnapshot.definition.policies.maxTransitions,
          state.id,
          visitNumber,
          target,
          timestamp,
        );
        if (transitionFailure) {
          await this.terminateRun(run, transitionFailure, timestamp);
          return run;
        }
        const committed = structuredClone(run);
        const committedVisit = committed.visits.at(-1)!;
        committedVisit.outcome = outcome;
        committedVisit.target = target;
        committed.documents.push(...documents);
        for (const document of documents)
          this.event(committed, "document_committed", timestamp(), {
            stateId: document.stateId,
            visitNumber: document.visitNumber,
            taskId: document.taskId,
            name: document.name,
            internalPath: document.internalPath,
            sha256: document.sha256,
          });
        if (committedVisit.type === "agent") {
          const committedAttempt = committedVisit.task.attempts.at(-1)!;
          committedAttempt.outcome = outcome;
          committedAttempt.documents = documents;
        } else {
          this.event(committed, "parallel_join_committed", timestamp(), {
            stateId: state.id,
            visitNumber,
            outcome,
            tasks: committedVisit.tasks.map((task) => ({
              id: task.id,
              status: task.status,
              attempts: task.attempts.length,
              ...(task.failure === undefined
                ? {}
                : { finalError: task.failure }),
            })),
          });
        }
        this.event(committed, "transition_committed", timestamp(), {
          stateId: state.id,
          visitNumber,
          outcome,
          target,
          transitionNumber: committed.transitionCount + 1,
        });
        committed.transitionCount += 1;
        if (target === "$succeeded" || target === "$failed") {
          if (workspaceMode(committed) === "worktree")
            await this.coordinator().observeAll(committed, timestamp);
          committed.terminalTarget = target;
          committed.status = terminalStatus(target);
          this.event(committed, "run_terminal", timestamp(), {
            status: committed.status,
            target,
          });
        }
        await this.runs.save(committed);
        run = committed;
        if (target === "$succeeded" || target === "$failed") return run;
        stateId = target;
      }
    } catch (error) {
      if (error instanceof RunCancellationRequestedError) return error.run;
      if (error instanceof ControllerDetachedError) {
        if (
          controllerId &&
          fencingToken !== undefined &&
          this.runs.releaseControl
        )
          try {
            await this.runs.releaseControl(
              run,
              controllerId,
              fencingToken,
              timestamp(),
            );
          } catch (releaseError) {
            if (releaseError instanceof RunCancellationRequestedError)
              return releaseError.run;
            throw releaseError;
          }
        throw error;
      }
      run.status = "failed";
      let failure = this.failure(error);
      try {
        if (workspaceMode(run) === "worktree")
          await this.coordinator().observeAll(run, timestamp);
      } catch (observationError) {
        failure = workspaceFailure(observationError);
      }
      run.failure = failure;
      this.event(run, "run_terminal", timestamp(), {
        status: "failed",
        failure,
      });
      await this.runs.save(run);
      throw error;
    }
  }

  private async executeNormalVisit(
    run: RunRecord,
    visit: NormalVisitRecord,
    state: NormalStateDefinition,
    timestamp: () => string,
    signal?: AbortSignal,
  ): Promise<
    | {
        kind: "completed";
        attempt: AttemptRecord;
        outcome: string;
        target: string;
        documents: RunRecord["documents"];
        diagnostic?: AttemptRecord["error"];
      }
    | TaskFailureResult
  > {
    const result = await this.executeTask(
      run,
      visit,
      visit.task,
      state,
      Object.keys(state.outcomes),
      false,
      projectWorkspaceForTask(run, visit, visit.task),
      timestamp,
      signal,
    );
    if (workspaceMode(run) === "worktree")
      await this.coordinator().observeTask(run, visit, visit.task, timestamp);
    if (result.kind !== "completed") return result;
    const target = state.outcomes[result.outcome];
    if (!target)
      throw new ResultValidationError(
        "outcome_invalid",
        `No transition configured for outcome ${result.outcome}`,
      );
    return { ...result, target };
  }

  private async executeParallelVisit(
    run: RunRecord,
    visit: ParallelVisitRecord,
    state: ParallelStateDefinition,
    timestamp: () => string,
    signal?: AbortSignal,
  ): Promise<
    | {
        kind: "completed";
        outcome: "succeeded" | "failed";
        target: string;
        documents: RunRecord["documents"];
        attempt?: AttemptRecord;
        diagnostic?: AttemptRecord["error"];
      }
    | TaskFailureResult
  > {
    let nextIndex = 0;
    const unsafeFailures: AttemptFailure[] = [];
    const globalFailures: AttemptFailure[] = [];
    let stopScheduling = false;
    const workers = Array.from(
      { length: state.effectiveMaxConcurrency },
      async () => {
        while (true) {
          if (stopScheduling) return;
          const schedulingFailure = await this.evaluateDeadline(
            run,
            timestamp,
            {
              phase: "parallel_scheduling",
              stateId: state.id,
              visitNumber: visit.number,
            },
          );
          if (schedulingFailure) {
            stopScheduling = true;
            globalFailures.push(schedulingFailure);
            return;
          }
          const index = nextIndex;
          nextIndex += 1;
          if (index >= visit.tasks.length) return;
          const task = visit.tasks[index];
          const definition = state.tasks[task.id];
          task.status = "running";
          this.event(run, "parallel_task_started", timestamp(), {
            stateId: state.id,
            visitNumber: visit.number,
            taskId: task.id,
          });
          await this.runs.save(run);
          try {
            const result = await this.executeTask(
              run,
              visit,
              task,
              definition,
              ["succeeded", "failed"],
              true,
              projectWorkspaceForTask(run, visit, task),
              timestamp,
              signal,
            );
            if (result.kind === "completed") {
              const attempt = task.attempts.at(-1)!;
              attempt.status = "succeeded";
              attempt.outcome = "succeeded";
              attempt.documents = result.documents;
              if (result.diagnostic !== undefined)
                attempt.error = result.diagnostic;
              task.status = "succeeded";
              task.outcome = "succeeded";
              task.documents = result.documents;
              this.event(run, "parallel_task_settled", timestamp(), {
                taskId: task.id,
                status: "succeeded",
                attempts: task.attempts.length,
                documents: result.documents.map(
                  (document) => document.internalPath,
                ),
              });
            } else {
              task.status = "failed";
              task.failure = result.failure;
              if (result.kind === "unsafe") unsafeFailures.push(result.failure);
              if (result.kind === "global_limit") {
                stopScheduling = true;
                globalFailures.push(result.failure);
              }
              this.event(run, "parallel_task_settled", timestamp(), {
                taskId: task.id,
                status: "failed",
                attempts: task.attempts.length,
                finalError: result.failure,
              });
            }
          } catch (error) {
            if (error instanceof ControllerDetachedError) throw error;
            const failure = this.failure(error);
            task.status = "failed";
            task.failure = failure;
            unsafeFailures.push(failure);
            this.event(run, "parallel_task_settled", timestamp(), {
              taskId: task.id,
              status: "failed",
              attempts: task.attempts.length,
              finalError: failure,
            });
          }
          if (workspaceMode(run) === "worktree")
            await this.coordinator().observeTask(run, visit, task, timestamp);
          await this.runs.save(run);
        }
      },
    );
    await Promise.all(workers);

    if (globalFailures.length)
      return { kind: "global_limit", failure: globalFailures[0] };
    if (unsafeFailures.length)
      return { kind: "unsafe", failure: unsafeFailures[0] };
    const outcome = calculateParallelOutcome(visit.tasks);
    const target = state.outcomes[outcome];
    const documents = visit.tasks.flatMap((task) => task.documents);
    return { kind: "completed", outcome, target, documents };
  }

  private async executeTask(
    run: RunRecord,
    visit: VisitRecord,
    task: TaskRecord,
    work: AgentWorkDefinition,
    allowedOutcomes: readonly string[],
    declaredFailedRetryable: boolean,
    projectWorkspace: string,
    timestamp: () => string,
    signal?: AbortSignal,
  ): Promise<
    | {
        kind: "completed";
        attempt: AttemptRecord;
        outcome: string;
        documents: RunRecord["documents"];
        diagnostic?: AttemptRecord["error"];
      }
    | TaskFailureResult
  > {
    const retryContext = {
      stateId: visit.stateId,
      visitNumber: visit.number,
      taskId: task.id,
    };
    for (
      let attemptNumber = 1;
      attemptNumber <= work.policies.maxAttempts;
      attemptNumber += 1
    ) {
      throwIfDetached(signal);
      const deadlineFailure = await this.evaluateDeadline(run, timestamp, {
        phase: "attempt_launch",
        stateId: visit.stateId,
        visitNumber: visit.number,
        taskId: task.id,
        attemptNumber,
      });
      if (deadlineFailure)
        return { kind: "global_limit", failure: deadlineFailure };
      const identity = `${run.id}:${visit.stateId}:${visit.number}:${task.id}:${attemptNumber}`;
      const attempt: AttemptRecord = {
        id: identity,
        number: attemptNumber,
        startedAt: timestamp(),
        status: "launching",
        controlWorkspace: "",
        contextPath: "",
        outputDirectory: "",
        resultPath: "",
        logs: { stdout: "", stderr: "" },
        documents: [],
      };
      attempt.deadlineAt = new Date(
        Date.parse(attempt.startedAt!) + work.policies.attemptTimeoutMs,
      ).toISOString();
      task.attempts.push(attempt);
      const paths = await this.runs.prepareAttempt(
        run,
        visit,
        task,
        attemptNumber,
      );
      Object.assign(attempt, paths);
      this.event(run, "attempt_launching", timestamp(), {
        identity,
        attemptNumber,
      });
      this.event(run, "task_scheduled", timestamp(), {
        stateId: visit.stateId,
        visitNumber: visit.number,
        taskId: task.id,
        attemptNumber,
        identity,
      });
      await this.runs.save(run);

      const attemptResult = await this.runAttempt(
        run,
        attempt,
        {
          identity,
          projectWorkspace,
          ...paths,
          instructions: work.agent.instructions,
          prompt: work.prompt,
          allowedOutcomes,
          runtime: work.agent.runtime,
          reasoning: work.agent.reasoning,
          timeoutMs: work.policies.attemptTimeoutMs,
          attemptNumber,
          signal,
          diagnosticContext: {
            runId: run.id,
            stateId: visit.stateId,
            visitNumber: visit.number,
            taskId: task.id,
            attemptNumber,
          },
        },
        timestamp,
        signal,
      );

      if (attemptResult.kind === "completed") {
        attempt.executor = attemptResult.execution.references;
        attempt.logs = attemptResult.execution.logs;
        try {
          const result = await this.runs.readResult(
            paths.resultPath,
            paths.outputDirectory,
            allowedOutcomes,
          );
          if (declaredFailedRetryable && result.outcome === "failed") {
            const failure = {
              code: "declared_failed",
              message:
                result.error === undefined
                  ? "Parallel task declared failed"
                  : `Parallel task declared failed: ${JSON.stringify(result.error)}`,
            };
            attempt.error = result.error;
            await this.recordFailure(run, attempt, failure, timestamp);
            const terminal = await this.retryOrFinish(
              run,
              attemptNumber,
              work,
              failure,
              retryContext,
              timestamp,
            );
            if (terminal) return terminal;
            continue;
          }
          const documents = await this.runs.stageDocuments(
            run,
            visit,
            task,
            paths.outputDirectory,
            result.documents,
          );
          return {
            kind: "completed",
            attempt,
            outcome: result.outcome,
            documents,
            ...(result.error === undefined ? {} : { diagnostic: result.error }),
          };
        } catch (error) {
          if (!(error instanceof ResultValidationError)) throw error;
          const failure = this.failure(error);
          await this.recordFailure(run, attempt, failure, timestamp);
          const terminal = await this.retryOrFinish(
            run,
            attemptNumber,
            work,
            failure,
            retryContext,
            timestamp,
          );
          if (terminal) return terminal;
          continue;
        }
      }

      await this.recordFailure(run, attempt, attemptResult.failure, timestamp);
      if (attemptResult.kind === "global_limit") {
        this.event(run, "retry_suppressed", timestamp(), {
          ...retryContext,
          failedAttemptNumber: attemptNumber,
          reason: "workflow_timeout",
          failure: attemptResult.failure,
        });
        await this.runs.save(run);
        return attemptResult;
      }
      if (attemptResult.kind === "unsafe") {
        this.event(run, "retry_suppressed", timestamp(), {
          ...retryContext,
          failedAttemptNumber: attemptNumber,
          reason: "external_execution_uncertain",
          failure: attemptResult.failure,
        });
        await this.runs.save(run);
        return attemptResult;
      }
      const terminal = await this.retryOrFinish(
        run,
        attemptNumber,
        work,
        attemptResult.failure,
        retryContext,
        timestamp,
      );
      if (terminal) return terminal;
    }
    throw new Error("Attempt budget loop ended without a result");
  }

  private async runAttempt(
    run: RunRecord,
    attempt: AttemptRecord,
    launch: TaskLaunch,
    timestamp: () => string,
    signal?: AbortSignal,
  ): Promise<AttemptResult> {
    const timeoutController = new AbortController();
    const observationController = new AbortController();
    const observationSignal = launch.signal
      ? AbortSignal.any([launch.signal, observationController.signal])
      : observationController.signal;
    let startedPersistence: Promise<void> | undefined;
    const execution = this.executor.execute(
      { ...launch, signal: observationSignal },
      async (references) => {
        if (attempt.status !== "launching") return;
        attempt.executor = references;
        attempt.status = "running";
        this.event(run, "attempt_started", timestamp(), {
          identity: attempt.id,
          ...references,
        });
        startedPersistence = this.runs.save(run);
        await startedPersistence;
      },
      async (externalEvent) => {
        this.recordExternalEvent(run, attempt, externalEvent, timestamp());
        await this.runs.save(run);
      },
    );
    const settled = execution.then(
      (value) => ({ kind: "completed", execution: value }) as const,
      (error: unknown) => {
        if (!(error instanceof TaskExecutorError)) throw error;
        attempt.logs = error.logs;
        return { kind: "failed", failure: this.failure(error) } as const;
      },
    );
    const workflowRemainingMs = Math.max(
      0,
      Date.parse(run.deadlineAt) - this.now().getTime(),
    );
    const workflowDeadlineControls = workflowRemainingMs <= launch.timeoutMs;
    const controllingTimeoutMs = Math.min(
      launch.timeoutMs,
      workflowRemainingMs,
    );
    const timeout = this.wait(
      controllingTimeoutMs,
      timeoutController.signal,
    ).then(
      () =>
        ({
          kind: "timeout",
          cause: workflowDeadlineControls
            ? ("workflow_timeout" as const)
            : ("attempt_timeout" as const),
        }) as const,
    );
    let result:
      | Awaited<typeof settled>
      | { kind: "timeout"; cause: "attempt_timeout" | "workflow_timeout" };
    try {
      result = await Promise.race([
        settled,
        timeout,
        ...(signal ? [detached(signal)] : []),
      ]);
    } catch (error) {
      timeoutController.abort();
      observationController.abort();
      throw error;
    }
    if (result.kind !== "timeout") {
      timeoutController.abort();
      observationController.abort();
      attempt.externalStatus = "stopped";
      return result;
    }

    void settled;
    observationController.abort();
    attempt.status = "timing_out";
    if (startedPersistence) await startedPersistence;
    if (result.cause === "workflow_timeout") {
      const clockAt = timestamp();
      const observedAt =
        Date.parse(clockAt) < Date.parse(run.deadlineAt)
          ? run.deadlineAt
          : clockAt;
      const evaluation = evaluateWorkflowDeadline(run.deadlineAt, observedAt);
      this.limitEvent(run, evaluation, observedAt, {
        phase: "active_attempt",
        identity: attempt.id,
      });
    }
    this.event(run, "attempt_timing_out", timestamp(), {
      identity: attempt.id,
      timeoutMs: controllingTimeoutMs,
      cause: result.cause,
    });
    await this.runs.save(run);
    return this.cancelAndReconcile(
      run,
      attempt,
      launch,
      result.cause,
      timestamp,
    );
  }

  private async cancelAndReconcile(
    run: RunRecord,
    attempt: AttemptRecord,
    launch: TaskLaunch,
    cause: "attempt_timeout" | "workflow_timeout",
    timestamp: () => string,
  ): Promise<AttemptResult> {
    const timeoutFailure =
      cause === "workflow_timeout"
        ? {
            code: "workflow_timeout",
            message: `Workflow deadline ${run.deadlineAt} expired during attempt ${attempt.id}`,
          }
        : {
            code: "attempt_timeout",
            message: `Attempt exceeded its ${launch.timeoutMs}ms timeout`,
          };
    if (!attempt.executor)
      return {
        kind: cause === "workflow_timeout" ? "global_limit" : "unsafe",
        failure:
          cause === "workflow_timeout"
            ? timeoutFailure
            : {
                code: "external_execution_uncertain",
                message:
                  "Attempt timed out before its external identity was confirmed",
              },
      };

    const references = attempt.executor;
    const requestedAt = timestamp();
    attempt.reconciliation = {
      cancellationRequestedAt: requestedAt,
      observations: [],
    };
    this.event(run, "attempt_cancellation_requested", requestedAt, {
      identity: attempt.id,
      ...this.references(references),
    });
    await this.runs.save(run);
    try {
      await this.executor.cancel(
        references,
        launch.projectWorkspace,
        launch.diagnosticContext,
      );
      const completedAt = timestamp();
      attempt.reconciliation.cancellationCommandCompletedAt = completedAt;
      this.event(run, "attempt_cancellation_command_completed", completedAt, {
        identity: attempt.id,
        ...this.references(references),
        cause,
      });
      await this.runs.save(run);
    } catch (error) {
      // A failed cancellation request is reconciled through authoritative status.
      this.event(run, "attempt_cancellation_request_failed", timestamp(), {
        identity: attempt.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.runs.save(run);
    }

    let elapsedMs = 0;
    while (true) {
      let status: Awaited<ReturnType<TaskExecutor["reconcile"]>>;
      try {
        status = await this.executor.reconcile(
          references,
          launch.projectWorkspace,
          launch.diagnosticContext,
        );
      } catch {
        status = "unknown";
      }
      const observedAt = timestamp();
      attempt.reconciliation.observations.push({ status, at: observedAt });
      attempt.externalStatus = status;
      this.event(run, "attempt_reconciled", observedAt, {
        identity: attempt.id,
        status,
      });
      if (status === "stopped") {
        attempt.reconciliation.confirmedStoppedAt = observedAt;
        await this.runs.save(run);
        return {
          kind: cause === "workflow_timeout" ? "global_limit" : "failed",
          failure: timeoutFailure,
        };
      }
      await this.runs.save(run);
      if (elapsedMs >= launch.timeoutMs) break;
      const delay = Math.min(
        reconciliationPollMs,
        launch.timeoutMs - elapsedMs,
      );
      if (delay <= 0) break;
      this.event(run, "reconciliation_wait_started", timestamp(), {
        identity: attempt.id,
        delayMs: delay,
      });
      await this.runs.save(run);
      await this.wait(delay);
      elapsedMs += delay;
      this.event(run, "reconciliation_wait_completed", timestamp(), {
        identity: attempt.id,
        delayMs: delay,
        elapsedMs,
      });
      await this.runs.save(run);
    }
    return cause === "workflow_timeout"
      ? { kind: "global_limit", failure: timeoutFailure }
      : {
          kind: "unsafe",
          failure: {
            code: "external_execution_uncertain",
            message:
              "Orca could not confirm that the timed-out execution stopped",
          },
        };
  }

  private async recordFailure(
    run: RunRecord,
    attempt: AttemptRecord,
    failure: AttemptFailure,
    timestamp: () => string,
  ): Promise<void> {
    attempt.status = "failed";
    attempt.failure = failure;
    this.event(run, "attempt_failed", timestamp(), {
      identity: attempt.id,
      attemptNumber: attempt.number,
      failure,
    });
    await this.runs.save(run);
  }

  private async retryOrFinish(
    run: RunRecord,
    attemptNumber: number,
    state: AgentWorkDefinition,
    failure: AttemptFailure,
    context: { stateId: string; visitNumber: number; taskId: string },
    timestamp: () => string,
  ): Promise<
    { kind: "failed" | "global_limit"; failure: AttemptFailure } | undefined
  > {
    const deadlineFailure = await this.evaluateDeadline(run, timestamp, {
      phase: "retry_decision",
      ...context,
      failedAttemptNumber: attemptNumber,
    });
    if (deadlineFailure)
      return { kind: "global_limit", failure: deadlineFailure };
    if (attemptNumber >= state.policies.maxAttempts) {
      this.event(run, "retry_exhausted", timestamp(), {
        ...context,
        failedAttemptNumber: attemptNumber,
        maxAttempts: state.policies.maxAttempts,
        failure,
      });
      await this.runs.save(run);
      return { kind: "failed", failure };
    }
    this.event(run, "retry_scheduled", timestamp(), {
      ...context,
      failedAttemptNumber: attemptNumber,
      nextAttemptNumber: attemptNumber + 1,
      delayMs: state.policies.retryDelayMs,
      failure,
    });
    await this.runs.save(run);
    const remainingMs = Math.max(
      0,
      Date.parse(run.deadlineAt) - this.now().getTime(),
    );
    const deadlineController = new AbortController();
    const delay = this.wait(state.policies.retryDelayMs).then(
      () => ({ kind: "delay" }) as const,
    );
    const deadline = this.wait(remainingMs, deadlineController.signal).then(
      () => ({ kind: "deadline" }) as const,
    );
    const settled = await Promise.race([delay, deadline]);
    if (settled.kind === "deadline") {
      const clockAt = timestamp();
      const observedAt =
        Date.parse(clockAt) < Date.parse(run.deadlineAt)
          ? run.deadlineAt
          : clockAt;
      const evaluation = evaluateWorkflowDeadline(run.deadlineAt, observedAt);
      this.limitEvent(run, evaluation, observedAt, {
        phase: "retry_delay",
        ...context,
        failedAttemptNumber: attemptNumber,
        nextAttemptNumber: attemptNumber + 1,
      });
      await this.runs.save(run);
      return {
        kind: "global_limit",
        failure: this.limitFailure(evaluation)!,
      };
    }
    deadlineController.abort();
    this.event(run, "retry_delay_completed", timestamp(), {
      ...context,
      failedAttemptNumber: attemptNumber,
      nextAttemptNumber: attemptNumber + 1,
      delayMs: state.policies.retryDelayMs,
    });
    await this.runs.save(run);
    const afterDelayFailure = await this.evaluateDeadline(run, timestamp, {
      phase: "retry_delay_completed",
      ...context,
      failedAttemptNumber: attemptNumber,
      nextAttemptNumber: attemptNumber + 1,
    });
    if (afterDelayFailure)
      return { kind: "global_limit", failure: afterDelayFailure };
    return undefined;
  }

  private async evaluateStateEntryLimits(
    run: RunRecord,
    stateId: string,
    proposedVisit: number,
    maxStateVisits: number,
    timestamp: () => string,
  ): Promise<AttemptFailure | undefined> {
    const deadlineFailure = await this.evaluateDeadline(run, timestamp, {
      phase: "state_entry",
      stateId,
      proposedVisit,
    });
    if (deadlineFailure) return deadlineFailure;
    const evaluation = evaluateStateVisitLimit(maxStateVisits, proposedVisit);
    this.limitEvent(run, evaluation, timestamp(), {
      phase: "state_entry",
      stateId,
    });
    await this.runs.save(run);
    return this.limitFailure(evaluation);
  }

  private async evaluateTransitionLimits(
    run: RunRecord,
    maxTransitions: number,
    stateId: string,
    visitNumber: number,
    target: string,
    timestamp: () => string,
  ): Promise<AttemptFailure | undefined> {
    const deadlineFailure = await this.evaluateDeadline(run, timestamp, {
      phase: "transition",
      stateId,
      visitNumber,
      target,
    });
    if (deadlineFailure) return deadlineFailure;
    const evaluation = evaluateTransitionLimit(
      maxTransitions,
      run.transitionCount + 1,
    );
    this.limitEvent(run, evaluation, timestamp(), {
      phase: "transition",
      stateId,
      visitNumber,
      target,
    });
    await this.runs.save(run);
    return this.limitFailure(evaluation);
  }

  private async evaluateDeadline(
    run: RunRecord,
    timestamp: () => string,
    context: Record<string, unknown>,
  ): Promise<AttemptFailure | undefined> {
    const observedAt = timestamp();
    const evaluation = evaluateWorkflowDeadline(run.deadlineAt, observedAt);
    this.limitEvent(run, evaluation, observedAt, context);
    await this.runs.save(run);
    return this.limitFailure(evaluation);
  }

  private limitEvent(
    run: RunRecord,
    evaluation: GlobalLimitEvaluation,
    at: string,
    context: Record<string, unknown>,
  ): void {
    this.event(run, "limit_evaluated", at, {
      ...context,
      ...evaluation,
      decision: evaluation.allowed ? "allowed" : "exceeded",
    });
  }

  private limitFailure(
    evaluation: GlobalLimitEvaluation,
  ): AttemptFailure | undefined {
    if (evaluation.allowed) return undefined;
    let message: string;
    if (evaluation.limit === "workflow_timeout")
      message = `Workflow deadline ${evaluation.effectiveDeadline} was reached at ${evaluation.observedAt}`;
    else if (evaluation.limit === "max_state_visits")
      message = `State visit limit ${evaluation.effectiveValue} was exceeded by visit ${evaluation.observedValue}`;
    else
      message = `Transition limit ${evaluation.effectiveValue} was exceeded by transition ${evaluation.observedValue}`;
    return {
      code: evaluation.terminalCause,
      message,
    };
  }

  private async terminateRun(
    run: RunRecord,
    requestedFailure: AttemptFailure,
    timestamp: () => string,
  ): Promise<void> {
    let failure = requestedFailure;
    try {
      if (workspaceMode(run) === "worktree")
        await this.coordinator().observeAll(run, timestamp);
    } catch (error) {
      failure = workspaceFailure(error);
    }
    run.status = "failed";
    run.failure = failure;
    this.event(run, "run_terminal", timestamp(), {
      status: "failed",
      failure,
    });
    await this.runs.save(run);
  }

  private failure(error: unknown): AttemptFailure {
    if (error instanceof ResultValidationError)
      return { code: error.code, message: error.message };
    if (error instanceof TaskExecutorError)
      return { code: error.code, message: error.message };
    return {
      code: "engine_failure",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  private coordinator(): ProjectWorkspaceCoordinator {
    return requireWorkspaceCoordinator(this.workspaceCoordinator);
  }

  private recordExternalEvent(
    run: RunRecord,
    attempt: AttemptRecord,
    externalEvent: ExternalEventRecord,
    at: string,
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
    const provenance = this.attemptProvenance(run, attempt);
    this.event(
      run,
      `orca_${externalEvent.type}_${externalEvent.status === "resolved" ? "resolved" : "observed"}`,
      at,
      {
        ...provenance,
        identity: attempt.id,
        externalEventId: externalEvent.id,
        status: externalEvent.status,
        ...(externalEvent.message === undefined
          ? {}
          : { message: externalEvent.message }),
      },
    );
  }

  private attemptProvenance(
    run: RunRecord,
    attempt: AttemptRecord,
  ): {
    stateId: string;
    visitNumber: number;
    taskId: string;
    attemptNumber: number;
  } {
    for (const visit of run.visits) {
      const tasks = visit.type === "agent" ? [visit.task] : visit.tasks;
      for (const task of tasks)
        if (task.attempts.includes(attempt))
          return {
            stateId: visit.stateId,
            visitNumber: visit.number,
            taskId: task.id,
            attemptNumber: attempt.number,
          };
    }
    throw new Error(`Attempt ${attempt.id} has no durable provenance`);
  }

  private references(references: ExecutorReferences): Record<string, unknown> {
    if (references.executionId) return { executionId: references.executionId };
    return {
      ...(references.runId ? { executorRunId: references.runId } : {}),
      executorTaskId: references.taskId,
      dispatchId: references.dispatchId,
      ...(references.terminalHandle
        ? { terminalHandle: references.terminalHandle }
        : {}),
    };
  }

  private event(
    run: RunRecord,
    type: string,
    at: string,
    data: Record<string, unknown>,
  ): void {
    run.events.push({ sequence: run.events.length + 1, type, at, data });
    this.diagnostics.emit({
      at,
      kind: "event",
      name: type,
      context: {
        runId: run.id,
        stateId: typeof data.stateId === "string" ? data.stateId : undefined,
        visitNumber:
          typeof data.visitNumber === "number" ? data.visitNumber : undefined,
        taskId: typeof data.taskId === "string" ? data.taskId : undefined,
        attemptNumber:
          typeof data.attemptNumber === "number"
            ? data.attemptNumber
            : undefined,
        executionId:
          typeof data.executionId === "string" ? data.executionId : undefined,
        dispatchId:
          typeof data.dispatchId === "string" ? data.dispatchId : undefined,
      },
      data,
    });
  }
}
