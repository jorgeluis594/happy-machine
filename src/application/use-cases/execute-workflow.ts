import type {
  AttemptFailure,
  AttemptRecord,
  RunRecord,
  VisitRecord,
} from "../../domain/execution/run.js";
import { terminalStatus } from "../../domain/execution/run.js";
import type { ProjectDefinitions } from "../../ports/project-definitions.js";
import type { NormalStateDefinition } from "../../ports/project-definitions.js";
import type { RunRepository } from "../../ports/run-repository.js";
import { ResultValidationError } from "../../ports/run-repository.js";
import type {
  TaskExecution,
  TaskExecutor,
  TaskLaunch,
} from "../../ports/task-executor.js";
import { TaskExecutorError } from "../../ports/task-executor.js";

export interface ExecuteWorkflowRequest {
  workflowPath: string;
  currentDirectory: string;
  inputPaths?: readonly string[];
  onRunAllocated(runId: string): void;
}

export type Wait = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

type AttemptResult =
  | { kind: "completed"; execution: TaskExecution }
  | { kind: "failed"; failure: AttemptFailure }
  | { kind: "unsafe"; failure: AttemptFailure };

const reconciliationPollMs = 100;

export class ExecuteWorkflow {
  constructor(
    private readonly definitions: ProjectDefinitions,
    private readonly runs: RunRepository,
    private readonly executor: TaskExecutor,
    private readonly now: () => Date,
    private readonly makeId: () => string,
    private readonly wait: Wait,
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
    let run: RunRecord = {
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

    try {
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

        const result = await this.executeVisit(
          run,
          visit,
          state,
          definition.projectRoot,
          timestamp,
        );
        if (result.kind !== "completed") {
          run.status = "failed";
          run.failure = result.failure;
          this.event(run, "run_terminal", timestamp(), {
            status: "failed",
            failure: result.failure,
          });
          await this.runs.save(run);
          return run;
        }

        const { attempt, outcome, target, documents, diagnostic } = result;
        const committed = structuredClone(run);
        const committedVisit = committed.visits.at(-1)!;
        const committedAttempt = committedVisit.task.attempts.at(-1)!;
        committedAttempt.outcome = outcome;
        committedAttempt.status = "succeeded";
        committedAttempt.documents = documents;
        if (diagnostic !== undefined) committedAttempt.error = diagnostic;
        committedVisit.outcome = outcome;
        committedVisit.target = target;
        committed.documents.push(...documents);
        this.event(committed, "attempt_succeeded", timestamp(), {
          identity: attempt.id,
          outcome,
          documents: documents.map((document) => document.internalPath),
        });
        this.event(committed, "transition_committed", timestamp(), {
          stateId: state.id,
          visitNumber,
          outcome,
          target,
        });
        if (target === "$succeeded" || target === "$failed") {
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
      run.status = "failed";
      const failure = this.failure(error);
      run.failure = failure;
      this.event(run, "run_terminal", timestamp(), {
        status: "failed",
        failure,
      });
      await this.runs.save(run);
      throw error;
    }
  }

  private async executeVisit(
    run: RunRecord,
    visit: VisitRecord,
    state: NormalStateDefinition,
    projectWorkspace: string,
    timestamp: () => string,
  ): Promise<
    | {
        kind: "completed";
        attempt: AttemptRecord;
        outcome: string;
        target: string;
        documents: RunRecord["documents"];
        diagnostic?: AttemptRecord["error"];
      }
    | { kind: "failed" | "unsafe"; failure: AttemptFailure }
  > {
    for (
      let attemptNumber = 1;
      attemptNumber <= state.policies.maxAttempts;
      attemptNumber += 1
    ) {
      const identity = `${run.id}:${state.id}:${visit.number}:${visit.task.id}:${attemptNumber}`;
      const attempt: AttemptRecord = {
        id: identity,
        number: attemptNumber,
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
      this.event(run, "attempt_launching", timestamp(), {
        identity,
        attemptNumber,
      });
      await this.runs.save(run);

      const attemptResult = await this.runAttempt(
        run,
        attempt,
        {
          identity,
          projectWorkspace,
          ...paths,
          instructions: state.agent.instructions,
          prompt: state.prompt,
          model: state.agent.model,
          timeoutMs: state.policies.attemptTimeoutMs,
          attemptNumber,
        },
        timestamp,
      );

      if (attemptResult.kind === "completed") {
        attempt.executor = attemptResult.execution.references;
        attempt.logs = attemptResult.execution.logs;
        try {
          const result = await this.runs.readResult(
            paths.resultPath,
            paths.outputDirectory,
            Object.keys(state.outcomes),
          );
          const target = state.outcomes[result.outcome];
          if (!target)
            throw new ResultValidationError(
              "outcome_invalid",
              `No transition configured for outcome ${result.outcome}`,
            );
          const documents = await this.runs.stageDocuments(
            run,
            paths.outputDirectory,
            result.documents,
          );
          return {
            kind: "completed",
            attempt,
            outcome: result.outcome,
            target,
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
            state,
            failure,
            timestamp,
          );
          if (terminal) return terminal;
          continue;
        }
      }

      await this.recordFailure(run, attempt, attemptResult.failure, timestamp);
      if (attemptResult.kind === "unsafe") {
        this.event(run, "retry_suppressed", timestamp(), {
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
        state,
        attemptResult.failure,
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
  ): Promise<AttemptResult> {
    const timeoutController = new AbortController();
    let startedPersistence: Promise<void> | undefined;
    const execution = this.executor.execute(launch, async (references) => {
      if (attempt.status !== "launching") return;
      attempt.executor = references;
      attempt.status = "running";
      this.event(run, "attempt_started", timestamp(), {
        identity: attempt.id,
        ...references,
      });
      startedPersistence = this.runs.save(run);
      await startedPersistence;
    });
    const settled = execution.then(
      (value) => ({ kind: "completed", execution: value }) as const,
      (error: unknown) =>
        ({ kind: "failed", failure: this.failure(error) }) as const,
    );
    const timeout = this.wait(launch.timeoutMs, timeoutController.signal).then(
      () => ({ kind: "timeout" }) as const,
    );
    const result = await Promise.race([settled, timeout]);
    if (result.kind !== "timeout") {
      timeoutController.abort();
      attempt.externalStatus = "stopped";
      return result;
    }

    void settled;
    attempt.status = "timing_out";
    if (startedPersistence) await startedPersistence;
    this.event(run, "attempt_timing_out", timestamp(), {
      identity: attempt.id,
      timeoutMs: launch.timeoutMs,
    });
    await this.runs.save(run);
    return this.cancelAndReconcile(run, attempt, launch, timestamp);
  }

  private async cancelAndReconcile(
    run: RunRecord,
    attempt: AttemptRecord,
    launch: TaskLaunch,
    timestamp: () => string,
  ): Promise<AttemptResult> {
    const timeoutFailure = {
      code: "attempt_timeout",
      message: `Attempt exceeded its ${launch.timeoutMs}ms timeout`,
    };
    if (!attempt.executor)
      return {
        kind: "unsafe",
        failure: {
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
      dispatchId: references.dispatchId,
    });
    await this.runs.save(run);
    try {
      await this.executor.cancel(references, launch.projectWorkspace);
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
        return { kind: "failed", failure: timeoutFailure };
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
    return {
      kind: "unsafe",
      failure: {
        code: "external_execution_uncertain",
        message: "Orca could not confirm that the timed-out execution stopped",
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
    state: NormalStateDefinition,
    failure: AttemptFailure,
    timestamp: () => string,
  ): Promise<{ kind: "failed"; failure: AttemptFailure } | undefined> {
    if (attemptNumber >= state.policies.maxAttempts) {
      this.event(run, "retry_exhausted", timestamp(), {
        failedAttemptNumber: attemptNumber,
        maxAttempts: state.policies.maxAttempts,
        failure,
      });
      await this.runs.save(run);
      return { kind: "failed", failure };
    }
    this.event(run, "retry_scheduled", timestamp(), {
      failedAttemptNumber: attemptNumber,
      nextAttemptNumber: attemptNumber + 1,
      delayMs: state.policies.retryDelayMs,
      failure,
    });
    await this.runs.save(run);
    await this.wait(state.policies.retryDelayMs);
    this.event(run, "retry_delay_completed", timestamp(), {
      failedAttemptNumber: attemptNumber,
      nextAttemptNumber: attemptNumber + 1,
      delayMs: state.policies.retryDelayMs,
    });
    await this.runs.save(run);
    return undefined;
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

  private event(
    run: RunRecord,
    type: string,
    at: string,
    data: Record<string, unknown>,
  ): void {
    run.events.push({ sequence: run.events.length + 1, type, at, data });
  }
}
