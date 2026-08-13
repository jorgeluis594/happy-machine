import type {
  ProjectHistoryResult,
  RunHistoryResult,
  RunStatusResult,
} from "../../../application/use-cases/inspect-runs.js";

type RunRecord = RunStatusResult["run"];
type VisitRecord = RunRecord["visits"][number];
type TaskRecord = VisitRecord extends infer Visit
  ? Visit extends { task: infer Task }
    ? Task
    : Visit extends { tasks: Array<infer Task> }
      ? Task
      : never
  : never;
type AttemptRecord = TaskRecord extends { attempts: Array<infer Attempt> }
  ? Attempt
  : never;

export class RunPresenter {
  status(result: RunStatusResult): string {
    const { run } = result;
    const current = run.visits.at(-1);
    const transition = [...run.events]
      .reverse()
      .find((event) => event.type === "transition_committed");
    const lines = [
      `Run: ${run.id}`,
      `Workflow: ${run.workflowId}`,
      `Snapshot: ${run.definitionSnapshot.identity}`,
      `Status: ${this.visibleStatus(result)}`,
      `Terminal reason: ${this.terminalReason(run)}`,
      `Cancellation: ${this.cancellation(run)}`,
      `Controller: ${result.leaseValid ? "attached" : "detached"}`,
      `Lease: ${this.lease(result)}`,
      `Current: ${current ? `${current.stateId} visit ${current.number} (${current.type})` : "none"}`,
      `Last outcome: ${transition?.data.outcome === undefined ? "none" : this.value(transition.data.outcome)}`,
      `Last transition: ${transition?.data.target === undefined ? "none" : this.value(transition.data.target)}`,
      ...(run.workspace?.mode === "worktree"
        ? ["Managed worktrees:", ...this.worktrees(run)]
        : []),
      "Tasks:",
      ...this.tasks(run, current),
      "Pending external events:",
      ...this.pendingEvents(run),
      "Cancellation executions:",
      ...this.cancellationExecutions(run),
      "Logs:",
      ...this.logs(run),
    ];
    return lines.join("\n");
  }

  private worktrees(run: RunRecord): string[] {
    const lines = (run.workspace?.worktrees ?? []).map(
      (worktree) =>
        `  ${worktree.id}: role=${worktree.role}${worktree.provenance ? ` state=${worktree.provenance.stateId} visit=${worktree.provenance.visitNumber} task=${worktree.provenance.taskId}` : ""} path=${worktree.path} branch=${worktree.branch} starting_head=${worktree.startingHead} ending_head=${worktree.endingHead} dirty=${String(worktree.dirty)}`,
    );
    return lines.length ? lines : ["  none"];
  }

  history(result: ProjectHistoryResult | RunHistoryResult): string {
    if ("runs" in result) {
      return [
        `Project: ${result.projectRoot}`,
        "Runs (newest first):",
        ...result.runs.map(
          (run) =>
            `${run.createdAt} ${run.id} workflow=${run.workflowId} status=${this.storedStatus(run)} snapshot=${run.definitionSnapshot.identity}`,
        ),
      ].join("\n");
    }
    return [
      `Run: ${result.run.id}`,
      `Snapshot: ${result.run.definitionSnapshot.identity}`,
      "Events:",
      ...result.run.events
        .slice()
        .sort((left, right) => left.sequence - right.sequence)
        .map(
          (event) =>
            `${event.sequence} ${event.at} ${event.type} ${JSON.stringify(event.data)}`,
        ),
      "Log references:",
      ...this.logs(result.run),
    ].join("\n");
  }

  private tasks(run: RunRecord, visit: VisitRecord | undefined): string[] {
    if (!visit) return ["  none"];
    const tasks: Array<{ task: TaskRecord; status: string }> =
      visit.type === "agent"
        ? [{ task: visit.task, status: this.taskStatus(visit.task) }]
        : visit.tasks.map((task) => ({
            task,
            status: task.status === "running" ? "active" : task.status,
          }));
    return tasks.flatMap(({ task, status }) => [
      `  ${status}: ${task.id}${"workspace" in task ? ` workspace=${task.workspace.path} mode=${task.workspace.mode}${task.workspace.branch ? ` branch=${task.workspace.branch}` : ""}${task.workspace.startingHead ? ` starting_head=${task.workspace.startingHead}` : ""}${task.workspace.endingHead ? ` ending_head=${task.workspace.endingHead}` : ""}${task.workspace.dirty === undefined ? "" : ` dirty=${String(task.workspace.dirty)}`}` : ""}`,
      ...(task.attempts.length
        ? task.attempts.map((attempt) => this.attempt(run, task, attempt))
        : ["    attempts: none"]),
    ]);
  }

  private pendingEvents(run: RunRecord): string[] {
    const lines = this.attempts(run).flatMap(({ visit, task, attempt }) =>
      (attempt.externalEvents ?? [])
        .filter((event) => event.status === "pending")
        .map(
          (event) =>
            `  ${event.type} ${event.id}: state=${visit.stateId} visit=${visit.number} task=${task.id} attempt=${attempt.number} observed=${event.observedAt}${event.message ? ` message=${JSON.stringify(event.message)}` : ""}`,
        ),
    );
    return lines.length ? lines : ["  none"];
  }

  private logs(run: RunRecord): string[] {
    const lines = this.attempts(run).map(({ visit, task, attempt }) =>
      [
        `  run=${run.id}`,
        `state=${visit.stateId}`,
        `visit=${visit.number}`,
        `task=${task.id}`,
        `attempt=${attempt.number}`,
        `stdout_bytes=${Buffer.byteLength(attempt.logs.stdout)}`,
        `stderr_bytes=${Buffer.byteLength(attempt.logs.stderr)}`,
      ].join(" "),
    );
    return lines.length ? lines : ["  none"];
  }

  private attempts(run: RunRecord): Array<{
    visit: VisitRecord;
    task: TaskRecord;
    attempt: AttemptRecord;
  }> {
    return run.visits.flatMap((visit) => {
      const tasks = visit.type === "agent" ? [visit.task] : visit.tasks;
      return tasks.flatMap((task) =>
        task.attempts.map((attempt) => ({ visit, task, attempt })),
      );
    });
  }

  private retry(
    run: RunRecord,
    task: TaskRecord,
    attempt: AttemptRecord,
  ): string {
    const attemptNumberIsAmbiguous =
      this.attempts(run).filter(
        (candidate) => candidate.attempt.number === attempt.number,
      ).length > 1;
    const event = [...run.events]
      .reverse()
      .find(
        (candidate) =>
          candidate.type.startsWith("retry_") &&
          candidate.data.failedAttemptNumber === attempt.number &&
          (candidate.data.taskId === task.id ||
            (candidate.data.taskId === undefined && !attemptNumberIsAmbiguous)),
      );
    if (!event) return "none";
    const delay = event.data.delayMs;
    return `${event.type}${delay === undefined ? "" : ` delay_ms=${this.value(delay)}`} at=${event.at}`;
  }

  private taskStatus(task: TaskRecord): string {
    const status = task.attempts.at(-1)?.status;
    if (!status) return "queued";
    if (
      status === "launching" ||
      status === "running" ||
      status === "timing_out"
    )
      return "active";
    return status;
  }

  private visibleStatus(result: RunStatusResult): string {
    return result.run.status === "running" && !result.leaseValid
      ? "detached"
      : result.run.status;
  }

  private storedStatus(run: RunRecord): string {
    return run.status === "running" && run.controllerStatus === "detached"
      ? "detached"
      : run.status;
  }

  private terminalReason(run: RunRecord): string {
    if (run.failure) return `${run.failure.code}: ${run.failure.message}`;
    if (run.terminalTarget) return run.terminalTarget;
    if (run.status === "canceled") return "explicit_cancellation";
    return "none";
  }

  private cancellation(run: RunRecord): string {
    if (!run.cancellation) return "none";
    return `requested=${run.cancellation.requestedAt} completed=${run.cancellation.completedAt ?? "pending"}`;
  }

  private attempt(
    run: RunRecord,
    task: TaskRecord,
    attempt: AttemptRecord,
  ): string {
    return `    attempt ${attempt.number}: ${attempt.status}; deadline=${attempt.deadlineAt ?? "unknown"}; retry=${this.retry(run, task, attempt)}; external=${attempt.externalStatus ?? "unknown"}; executor=${this.executor(attempt)}; cancellation=${this.attemptCancellation(attempt)}; workspace=${attempt.controlWorkspace}`;
  }

  private cancellationExecutions(run: RunRecord): string[] {
    const lines = this.attempts(run)
      .filter(({ attempt }) => attempt.executor || attempt.reconciliation)
      .map(
        ({ visit, task, attempt }) =>
          `  state=${visit.stateId} visit=${visit.number} task=${task.id} attempt=${attempt.number} external=${attempt.externalStatus ?? "unknown"} executor=${this.executor(attempt)} cancellation=${this.attemptCancellation(attempt)}`,
      );
    return lines.length ? lines : ["  none"];
  }

  private executor(attempt: AttemptRecord): string {
    if (!attempt.executor) return "none";
    if (attempt.executor.executionId)
      return `execution=${attempt.executor.executionId}`;
    return `task=${attempt.executor.taskId},dispatch=${attempt.executor.dispatchId}${attempt.executor.terminalHandle ? `,terminal=${attempt.executor.terminalHandle}` : ""}`;
  }

  private attemptCancellation(attempt: AttemptRecord): string {
    const lastObservation = attempt.reconciliation?.observations.at(-1);
    return attempt.reconciliation
      ? `requested=${attempt.reconciliation.cancellationRequestedAt},command_completed=${attempt.reconciliation.cancellationCommandCompletedAt ?? "pending"},status=${lastObservation?.status ?? "pending"},observed=${lastObservation?.at ?? "none"},confirmed_stopped=${attempt.reconciliation.confirmedStoppedAt ?? "none"}`
      : "none";
  }

  private lease(result: RunStatusResult): string {
    const lease = result.run.controllerLease;
    if (!lease) return "none";
    return `${result.leaseValid ? "valid" : "expired"} controller=${lease.controllerId} token=${lease.fencingToken} expires=${lease.expiresAt} observed=${result.observedAt}`;
  }

  private value(value: unknown): string {
    return typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
      ? String(value)
      : (JSON.stringify(value) ?? "undefined");
  }
}
