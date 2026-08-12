import type {
  AttemptRecord,
  ExternalEventRecord,
  ExternalExecutionStatus,
  ExecutorReferences,
  RunRecord,
  TaskRecord,
  VisitRecord,
} from "../../domain/execution/run.js";
import {
  projectWorkspaceForTask,
  workspaceMode,
} from "../../domain/execution/run.js";
import type { RunRepository } from "../../ports/run-repository.js";
import type {
  RecoveryObservation,
  TaskExecutor,
} from "../../ports/task-executor.js";
import { throwIfDetached } from "../services/controller-detachment.js";
import {
  type ProjectWorkspaceCoordinator,
  requireWorkspaceCoordinator,
  workspaceFailure,
} from "../services/project-workspace-coordinator.js";

export interface CancelWorkflowRequest {
  currentDirectory: string;
  runId: string;
  controllerId: string;
  signal?: AbortSignal;
}

export type CancellationWait = (
  milliseconds: number,
  signal?: AbortSignal,
) => Promise<void>;

interface ControlledCancellation {
  run: RunRecord;
  controllerId: string;
  fencingToken: number;
  signal?: AbortSignal;
}

interface ActiveAttempt {
  visit: VisitRecord;
  task: TaskRecord;
  attempt: AttemptRecord;
}

const reconciliationPollMs = 100;

export class CancelWorkflow {
  constructor(
    private readonly runs: RunRepository,
    private readonly executor: TaskExecutor,
    private readonly now: () => Date,
    private readonly wait: CancellationWait,
    private readonly workspaceCoordinator?: ProjectWorkspaceCoordinator,
  ) {}

  async cancel(request: CancelWorkflowRequest): Promise<RunRecord> {
    if (!this.runs.discoverProjectRoot || !this.runs.requestCancellation)
      throw new Error("Run repository does not support durable cancellation");
    const projectRoot = await this.runs.discoverProjectRoot(
      request.currentDirectory,
    );
    const accepted = await this.runs.requestCancellation(
      projectRoot,
      request.runId,
      request.controllerId,
      this.timestamp(),
    );
    if (!accepted.accepted) return accepted.run;

    const controlled: ControlledCancellation = {
      run: accepted.run,
      controllerId: request.controllerId,
      fencingToken: accepted.fencingToken,
      signal: request.signal,
    };
    try {
      await this.reconcileActiveAttempts(controlled);
      if (workspaceMode(controlled.run) === "worktree")
        try {
          await this.coordinator().observeAll(
            controlled.run,
            () => this.timestamp(),
            "run_canceled",
          );
        } catch (error) {
          this.event(
            controlled.run,
            "worktree_observation_failed",
            this.timestamp(),
            { phase: "run_canceled", failure: workspaceFailure(error) },
          );
        }
      const completedAt = this.timestamp();
      controlled.run.status = "canceled";
      controlled.run.cancellation ??= {
        requestedAt: completedAt,
      };
      controlled.run.cancellation.completedAt = completedAt;
      this.event(controlled.run, "run_status_changed", completedAt, {
        from: "canceling",
        to: "canceled",
      });
      this.event(controlled.run, "run_cancellation_completed", completedAt, {
        requestedAt: controlled.run.cancellation.requestedAt,
      });
      this.event(controlled.run, "run_terminal", completedAt, {
        status: "canceled",
        reason: "explicit_cancellation",
      });
      await this.persist(controlled);
    } finally {
      if (
        this.runs.releaseControl &&
        controlled.run.controllerLease?.controllerId ===
          controlled.controllerId &&
        controlled.run.controllerLease.fencingToken === controlled.fencingToken
      )
        controlled.run = await this.runs.releaseControl(
          controlled.run,
          controlled.controllerId,
          controlled.fencingToken,
          this.timestamp(),
        );
    }
    return controlled.run;
  }

  private async reconcileActiveAttempts(
    controlled: ControlledCancellation,
  ): Promise<void> {
    for (const item of this.activeAttempts(controlled.run)) {
      throwIfDetached(controlled.signal);
      await this.reconcileAttempt(controlled, item);
      if ("status" in item.task && item.task.status === "running")
        item.task.status = "canceled";
      await this.persist(controlled);
    }
  }

  private async reconcileAttempt(
    controlled: ControlledCancellation,
    item: ActiveAttempt,
  ): Promise<void> {
    const { attempt } = item;
    const projectWorkspace = projectWorkspaceForTask(
      controlled.run,
      item.visit,
      item.task,
    );
    const observation = await this.recover(attempt, projectWorkspace);
    if (observation && observation.status !== "not_found") {
      attempt.executor = observation.references;
      attempt.logs = {
        stdout: attempt.logs.stdout || observation.logs.stdout,
        stderr: attempt.logs.stderr || observation.logs.stderr,
      };
      this.mergeExternalEvents(attempt, observation.events ?? []);
      await this.persist(controlled);
    }

    if (
      observation?.status === "completed" ||
      observation?.status === "failed" ||
      (observation?.status === "not_found" && !attempt.executor)
    ) {
      const status = "stopped" as const;
      this.recordObservation(controlled.run, item, status, observation.status);
      attempt.status = "canceled";
      return;
    }

    const references = attempt.executor;
    if (!references) {
      this.recordObservation(
        controlled.run,
        item,
        "unknown",
        observation?.status ?? "recovery_failed",
      );
      attempt.status = "canceled";
      return;
    }

    while (true) {
      throwIfDetached(controlled.signal);
      await this.ensureCancellationRequested(
        controlled,
        item,
        references,
        projectWorkspace,
      );
      const status = await this.reconcile(references, projectWorkspace);
      this.recordObservation(controlled.run, item, status);
      await this.persist(controlled);
      if (status !== "active") {
        attempt.status = "canceled";
        return;
      }
      await this.wait(reconciliationPollMs);
    }
  }

  private async ensureCancellationRequested(
    controlled: ControlledCancellation,
    item: ActiveAttempt,
    references: ExecutorReferences,
    projectWorkspace: string,
  ): Promise<void> {
    const { attempt } = item;
    if (!attempt.reconciliation) {
      const requestedAt = this.timestamp();
      attempt.reconciliation = {
        cancellationRequestedAt: requestedAt,
        observations: [],
      };
      this.event(
        controlled.run,
        "attempt_cancellation_requested",
        requestedAt,
        {
          ...this.provenance(item),
          identity: attempt.id,
          ...this.references(references),
          cause: "user_cancellation",
        },
      );
      await this.persist(controlled);
    }
    if (attempt.reconciliation.cancellationCommandCompletedAt) return;
    try {
      await this.executor.cancel(references, projectWorkspace);
      const completedAt = this.timestamp();
      attempt.reconciliation.cancellationCommandCompletedAt = completedAt;
      this.event(
        controlled.run,
        "attempt_cancellation_command_completed",
        completedAt,
        {
          ...this.provenance(item),
          identity: attempt.id,
          dispatchId: references.dispatchId,
        },
      );
    } catch (error) {
      this.event(
        controlled.run,
        "attempt_cancellation_request_failed",
        this.timestamp(),
        {
          ...this.provenance(item),
          identity: attempt.id,
          error: error instanceof Error ? error.message : String(error),
          cause: "user_cancellation",
        },
      );
    }
    await this.persist(controlled);
  }

  private async recover(
    attempt: AttemptRecord,
    projectWorkspace: string,
  ): Promise<RecoveryObservation | undefined> {
    if (!this.executor.recover) return undefined;
    try {
      return await this.executor.recover(
        attempt.id,
        attempt.executor,
        projectWorkspace,
      );
    } catch {
      return undefined;
    }
  }

  private async reconcile(
    references: ExecutorReferences,
    projectWorkspace: string,
  ): Promise<ExternalExecutionStatus> {
    try {
      return await this.executor.reconcile(references, projectWorkspace);
    } catch {
      return "unknown";
    }
  }

  private recordObservation(
    run: RunRecord,
    item: ActiveAttempt,
    status: ExternalExecutionStatus,
    recoveredStatus?: string,
  ): void {
    const observedAt = this.timestamp();
    item.attempt.reconciliation ??= {
      cancellationRequestedAt: run.cancellation?.requestedAt ?? observedAt,
      observations: [],
    };
    item.attempt.reconciliation.observations.push({ status, at: observedAt });
    item.attempt.externalStatus = status;
    if (status === "stopped")
      item.attempt.reconciliation.confirmedStoppedAt = observedAt;
    this.event(run, "attempt_reconciled", observedAt, {
      ...this.provenance(item),
      identity: item.attempt.id,
      status,
      ...(recoveredStatus ? { recoveredStatus } : {}),
      cause: "user_cancellation",
    });
    if (status === "unknown")
      this.event(run, "attempt_cancellation_uncertain", observedAt, {
        ...this.provenance(item),
        identity: item.attempt.id,
      });
  }

  private activeAttempts(run: RunRecord): ActiveAttempt[] {
    return run.visits.flatMap((visit) => {
      const tasks = visit.type === "agent" ? [visit.task] : visit.tasks;
      return tasks.flatMap((task) =>
        task.attempts
          .filter(
            (attempt) =>
              attempt.status === "launching" ||
              attempt.status === "running" ||
              attempt.status === "timing_out",
          )
          .map((attempt) => ({ visit, task, attempt })),
      );
    });
  }

  private mergeExternalEvents(
    attempt: AttemptRecord,
    events: readonly ExternalEventRecord[],
  ): void {
    attempt.externalEvents ??= [];
    for (const event of events) {
      const existing = attempt.externalEvents.find(
        (candidate) => candidate.id === event.id,
      );
      if (existing) Object.assign(existing, event);
      else attempt.externalEvents.push(event);
    }
  }

  private provenance(item: ActiveAttempt): Record<string, unknown> {
    return {
      stateId: item.visit.stateId,
      visitNumber: item.visit.number,
      taskId: item.task.id,
      attemptNumber: item.attempt.number,
    };
  }

  private references(references: ExecutorReferences): Record<string, unknown> {
    return {
      ...(references.runId ? { executorRunId: references.runId } : {}),
      executorTaskId: references.taskId,
      dispatchId: references.dispatchId,
      ...(references.terminalHandle
        ? { terminalHandle: references.terminalHandle }
        : {}),
    };
  }

  private async persist(controlled: ControlledCancellation): Promise<void> {
    if (!this.runs.saveControlled || !this.runs.renewControl)
      throw new Error("Run repository does not support fenced persistence");
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

  private event(
    run: RunRecord,
    type: string,
    at: string,
    data: Record<string, unknown>,
  ): void {
    run.events.push({ sequence: run.events.length + 1, type, at, data });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private coordinator(): ProjectWorkspaceCoordinator {
    return requireWorkspaceCoordinator(this.workspaceCoordinator);
  }
}
