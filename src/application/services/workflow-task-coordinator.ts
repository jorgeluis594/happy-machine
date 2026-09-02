import type {
  ParallelTaskRecord,
  RunRecord,
} from "../../domain/execution/run.js";
import {
  cancelWorkflowTask,
  reserveWorkflowChild,
  settleWorkflowTask,
  transitionWorkflowTask,
  type WorkflowTaskCoordinate,
} from "../../domain/execution/workflow-task.js";
import type {
  AgentWorkDefinition,
  ParallelTaskDefinition,
  WorkflowWorkDefinition,
} from "../../ports/project-definitions.js";
import type { RunRepository } from "../../ports/run-repository.js";
import type { WorkflowController } from "../../ports/workflow-controller.js";
import type { TaskExecutor } from "../../ports/task-executor.js";
import { WorkflowTaskEvaluator } from "./workflow-task-evaluator.js";

export class WorkflowTaskCoordinator {
  constructor(
    private readonly runs: RunRepository,
    private readonly controller: WorkflowController,
    private readonly evaluator: WorkflowTaskEvaluator,
    private readonly now: () => Date,
    private readonly wait: (
      milliseconds: number,
      signal?: AbortSignal,
    ) => Promise<void>,
    private readonly executor?: TaskExecutor,
  ) {}

  async recover(
    parent: RunRecord,
    visit: Extract<RunRecord["visits"][number], { type: "parallel" }>,
    task: ParallelTaskRecord,
    work: WorkflowWorkDefinition,
    signal?: AbortSignal,
  ): Promise<void> {
    void visit;
    if (!task.execution || task.execution.type !== "workflow")
      throw new Error("Workflow wrapper was not materialized");
    const wrapper = task.execution;
    if (wrapper.phase === "succeeded" || wrapper.phase === "failed") {
      if (!wrapper.result)
        throw new Error("Workflow wrapper has terminal phase without envelope");
      task.status = wrapper.phase;
      task.outcome = wrapper.phase === "succeeded" ? "succeeded" : undefined;
      task.documents = wrapper.result.documents;
      return;
    }
    if (!this.runs.getOrCreateChildRun || !this.runs.loadChildRun)
      throw new Error("Run repository does not support workflow children");
    const child = await this.runs.getOrCreateChildRun({
      projectRoot: parent.projectRoot,
      parentRunId: parent.id,
      coordinate: wrapper.coordinate,
      workflowId: work.workflowId,
      workflowSnapshotIdentity: parent.definitionSnapshot.identity,
      resolvedWith: wrapper.resolvedWith,
      workflowDefinition: work.workflow,
      parentSnapshot: parent.definitionSnapshot,
      createdAt: parent.createdAt,
      deadlineAt: parent.deadlineAt,
      provenance: {
        runId: parent.id,
        stateId: wrapper.coordinate.stateId,
        visitNumber: wrapper.coordinate.visitNumber,
        taskId: wrapper.coordinate.taskId,
      },
    });
    this.event(parent, "child_run_reserved", wrapper, {
      workflowId: work.workflowId,
    });
    const provenance = {
      projectRoot: child.projectRoot,
      childRunId: child.id,
      parentRunId: parent.id,
      stateId: wrapper.coordinate.stateId,
      visitNumber: wrapper.coordinate.visitNumber,
      taskId: wrapper.coordinate.taskId,
    };
    let observation = await this.controller.recover({
      projectRoot: child.projectRoot,
      provenance,
    });
    if (observation.status === "not_started") {
      if (child.status === "running") {
        wrapper.phase = "child_running";
        const started = await this.controller.start({
          projectRoot: child.projectRoot,
          childRunId: child.id,
          provenance,
        });
        wrapper.childController = {
          executionId: started.identity.executionId,
          logs: {
            stdout: started.diagnostics.stdoutPath,
            stderr: started.diagnostics.stderrPath,
          },
        };
        this.event(parent, "child_run_started", wrapper, {
          executionId: started.identity.executionId,
        });
        await this.runs.save(parent);
        observation = await this.controller.recover({
          projectRoot: child.projectRoot,
          provenance,
        });
      } else if (
        child.status !== "succeeded" &&
        child.status !== "failed" &&
        child.status !== "canceled"
      ) {
        throw new Error("Child provenance is neither running nor terminal");
      } else {
        wrapper.phase = "child_running";
      }
    }
    if (
      observation.status === "start_unknown" ||
      observation.status === "stop_unknown" ||
      observation.status === "irreconcilable"
    )
      throw new Error(
        `workflow_controller_${observation.status}: ${observation.message}`,
      );
    if (observation.status === "active") {
      while (observation.status === "active") {
        await this.wait(100, signal);
        observation = await this.controller.reconcile({
          projectRoot: child.projectRoot,
          identity: observation.identity,
        });
        if (
          observation.status === "start_unknown" ||
          observation.status === "stop_unknown" ||
          observation.status === "irreconcilable"
        )
          throw new Error(
            `workflow_controller_${observation.status}: ${observation.message}`,
          );
      }
    }
    if (observation.status === "terminal") {
      wrapper.childController = {
        executionId: observation.identity.executionId,
        logs: {
          stdout: observation.diagnostics.stdoutPath,
          stderr: observation.diagnostics.stderrPath,
        },
      };
      this.event(parent, "child_run_settled", wrapper, {
        status: observation.terminalStatus,
        executionId: observation.identity.executionId,
      });
      await this.runs.save(parent);
    }
    const terminal = (await this.runs.loadChildRun(child.projectRoot, child.id))
      .run;
    if (
      terminal.status !== "succeeded" &&
      terminal.status !== "failed" &&
      terminal.status !== "canceled"
    )
      throw new Error(
        "Controller reported terminal without terminal child state",
      );
    this.event(parent, "child_run_settled", wrapper, {
      status: terminal.status,
      executionId: wrapper.childController?.executionId,
    });
    await this.runs.save(parent);
    if (wrapper.result) {
      task.status = wrapper.result.status;
      task.outcome =
        wrapper.result.status === "succeeded" ? "succeeded" : undefined;
      task.documents = wrapper.result.documents;
      wrapper.phase = wrapper.result.status;
      return;
    }
    const result = await this.evaluator.evaluate({
      parent,
      coordinate: wrapper.coordinate,
      child: terminal,
      childDefinition: work.workflow,
      work,
      resolvedWith: wrapper.resolvedWith,
      signal,
    });
    task.execution = settleWorkflowTask(wrapper, result.envelope);
    task.status = result.envelope.status;
    task.outcome =
      result.envelope.status === "succeeded" ? "succeeded" : undefined;
    task.documents = result.envelope.documents;
  }

  async cancel(
    parent: RunRecord,
    task: ParallelTaskRecord,
    signal?: AbortSignal,
  ): Promise<"stopped" | "unknown"> {
    if (!task.execution || task.execution.type !== "workflow") return "stopped";
    const wrapper = task.execution;
    if (
      wrapper.phase === "succeeded" ||
      wrapper.phase === "failed" ||
      wrapper.phase === "canceled"
    )
      return "stopped";
    if (wrapper.phase === "queued") {
      cancelWorkflowTask(wrapper);
      task.status = "canceled";
      return "stopped";
    }
    let result: "stopped" | "unknown" = "stopped";
    const child = this.runs.loadChildRun
      ? await this.runs
          .loadChildRun(parent.projectRoot, wrapper.childRunId)
          .then((value) => value.run)
      : undefined;
    if (child && child.status === "running" && wrapper.childController) {
      try {
        await this.controller.cancel({
          projectRoot: child.projectRoot,
          identity: {
            executionId: wrapper.childController.executionId,
            provenance: {
              projectRoot: child.projectRoot,
              childRunId: child.id,
              parentRunId: parent.id,
              stateId: wrapper.coordinate.stateId,
              visitNumber: wrapper.coordinate.visitNumber,
              taskId: wrapper.coordinate.taskId,
            },
          },
        });
        for (;;) {
          const observed = await this.controller.reconcile({
            projectRoot: child.projectRoot,
            identity: {
              executionId: wrapper.childController.executionId,
              provenance: {
                projectRoot: child.projectRoot,
                childRunId: child.id,
                parentRunId: parent.id,
                stateId: wrapper.coordinate.stateId,
                visitNumber: wrapper.coordinate.visitNumber,
                taskId: wrapper.coordinate.taskId,
              },
            },
          });
          if (observed.status !== "active") {
            if (observed.status !== "terminal") result = "unknown";
            break;
          }
          await this.wait(100, signal);
        }
      } catch {
        result = "unknown";
      }
    }
    for (const attempt of wrapper.evaluationAttempts.filter(
      (candidate) =>
        candidate.status === "launching" || candidate.status === "running",
    )) {
      if (!this.executor) {
        result = "unknown";
        continue;
      }
      const status = await this.evaluator.cancelAttempt(
        parent,
        wrapper.coordinate,
        attempt,
        signal,
      );
      if (status === "unknown") result = "unknown";
    }
    cancelWorkflowTask(wrapper);
    task.status = "canceled";
    return result;
  }

  async prepareParallel(
    parent: RunRecord,
    visit: Extract<RunRecord["visits"][number], { type: "parallel" }>,
    definitions: Readonly<
      Record<
        string,
        AgentWorkDefinition | ParallelTaskDefinition | WorkflowWorkDefinition
      >
    >,
  ): Promise<void> {
    if (!this.runs.reserveChildRuns) return;
    const prepared: Array<{
      task: ParallelTaskRecord;
      request: Parameters<
        NonNullable<RunRepository["reserveChildRuns"]>
      >[0][number];
    }> = [];
    for (const task of visit.tasks) {
      const work = definitions[task.id];
      if (!isWorkflow(work)) continue;
      const coordinate = this.coordinate(
        parent,
        visit.stateId,
        visit.number,
        task.id,
      );
      const resolvedWith = task.dynamic
        ? resolveBindings(work.with, task.dynamic.workItem)
        : resolveBindings(work.with);
      prepared.push({
        task,
        request: {
          projectRoot: parent.projectRoot,
          parentRunId: parent.id,
          coordinate,
          workflowId: work.workflowId,
          workflowSnapshotIdentity: parent.definitionSnapshot.identity,
          resolvedWith,
          provenance: {
            runId: parent.id,
            stateId: coordinate.stateId,
            visitNumber: coordinate.visitNumber,
            taskId: coordinate.taskId,
          },
        },
      });
    }
    const reservations = await this.runs.reserveChildRuns(
      prepared.map(({ request }) => request),
    );
    prepared.forEach(({ task, request }, index) => {
      const reservation = reservations[index];
      const existing = task.execution;
      if (existing?.type === "workflow") {
        reserveWorkflowChild(
          existing,
          reservation.childRunId,
          request.coordinate,
        );
        if (
          JSON.stringify(existing.resolvedWith) !==
          JSON.stringify(request.resolvedWith)
        )
          throw new Error("Workflow wrapper bindings changed");
      } else {
        task.execution = {
          type: "workflow",
          phase: "queued",
          coordinate: request.coordinate,
          childRunId: reservation.childRunId,
          resolvedWith: request.resolvedWith,
          evaluationAttempts: [],
        };
      }
    });
    parent.childRunReservations = structuredClone(
      parent.childRunReservations ?? [],
    );
    for (const reservation of reservations)
      if (
        parent.childRunReservations.some(
          (entry) =>
            this.sameCoordinate(entry.coordinate, reservation.coordinate) &&
            !this.sameReservation(entry, reservation),
        )
      )
        throw new Error(
          "Parent wrapper reservation conflicts with durable intent",
        );
      else if (
        !parent.childRunReservations.some((entry) =>
          this.sameCoordinate(entry.coordinate, reservation.coordinate),
        )
      )
        parent.childRunReservations.push(structuredClone(reservation));
    await this.runs.save(parent);
  }

  async execute(
    parent: RunRecord,
    visit: Extract<RunRecord["visits"][number], { type: "parallel" }>,
    task: ParallelTaskRecord,
    work: WorkflowWorkDefinition,
    signal?: AbortSignal,
  ) {
    if (!this.runs.getOrCreateChildRun || !this.runs.loadChildRun)
      throw new Error("Run repository does not support workflow children");
    if (!task.execution || task.execution.type !== "workflow")
      throw new Error("Workflow wrapper was not materialized");
    const wrapper = task.execution;
    const coordinate = wrapper.coordinate;
    const child = await this.runs.getOrCreateChildRun({
      projectRoot: parent.projectRoot,
      parentRunId: parent.id,
      coordinate,
      workflowId: work.workflowId,
      workflowSnapshotIdentity: parent.definitionSnapshot.identity,
      resolvedWith: wrapper.resolvedWith,
      workflowDefinition: work.workflow,
      parentSnapshot: parent.definitionSnapshot,
      createdAt: parent.createdAt,
      deadlineAt: parent.deadlineAt,
      provenance: {
        runId: parent.id,
        stateId: coordinate.stateId,
        visitNumber: coordinate.visitNumber,
        taskId: coordinate.taskId,
      },
    });
    this.event(parent, "child_run_reserved", wrapper, {
      workflowId: work.workflowId,
    });
    if (wrapper.phase === "queued") {
      wrapper.phase = transitionWorkflowTask(wrapper.phase, "child_running");
      await this.runs.save(parent);
    }
    if (child.status === "running") {
      const execution = await this.controller.start({
        projectRoot: child.projectRoot,
        childRunId: child.id,
        provenance: {
          projectRoot: child.projectRoot,
          childRunId: child.id,
          parentRunId: parent.id,
          stateId: coordinate.stateId,
          visitNumber: coordinate.visitNumber,
          taskId: coordinate.taskId,
        },
      });
      wrapper.childController = {
        executionId: execution.identity.executionId,
        logs: {
          stdout: execution.diagnostics.stdoutPath,
          stderr: execution.diagnostics.stderrPath,
        },
      };
      this.event(parent, "child_run_started", wrapper, {
        executionId: execution.identity.executionId,
      });
      await this.runs.save(parent);
    }
    let terminal = (await this.runs.loadChildRun(child.projectRoot, child.id))
      .run;
    while (terminal.status === "running" || terminal.status === "canceling") {
      await this.wait(100, signal);
      terminal = (await this.runs.loadChildRun(child.projectRoot, child.id))
        .run;
    }
    if (terminal.status !== "succeeded" && terminal.status !== "failed")
      throw new Error(
        `Child workflow ended in unsupported state: ${terminal.status}`,
      );
    this.event(parent, "child_run_settled", wrapper, {
      status: terminal.status,
      executionId: wrapper.childController?.executionId,
    });
    const result = await this.evaluator.evaluate({
      parent,
      coordinate,
      child: terminal,
      childDefinition: work.workflow,
      work,
      resolvedWith: wrapper.resolvedWith,
      signal,
    });
    task.execution = settleWorkflowTask(wrapper, result.envelope);
    task.status = result.envelope.status;
    task.outcome =
      result.envelope.status === "succeeded" ? "succeeded" : undefined;
    task.documents = result.envelope.documents;
    return result.envelope;
  }

  private coordinate(
    parent: RunRecord,
    stateId: string,
    visitNumber: number,
    taskId: string,
  ): WorkflowTaskCoordinate {
    return { parentRunId: parent.id, stateId, visitNumber, taskId };
  }

  private event(
    parent: RunRecord,
    type: string,
    wrapper: Extract<ParallelTaskRecord["execution"], { type: "workflow" }>,
    extra: Record<string, unknown> = {},
  ): void {
    const data = {
      parentRunId: parent.id,
      stateId: wrapper.coordinate.stateId,
      visitNumber: wrapper.coordinate.visitNumber,
      taskId: wrapper.coordinate.taskId,
      childRunId: wrapper.childRunId,
      ...extra,
    };
    const duplicate = parent.events.some(
      (event) =>
        event.type === type &&
        event.data.parentRunId === data.parentRunId &&
        event.data.stateId === data.stateId &&
        event.data.visitNumber === data.visitNumber &&
        event.data.taskId === data.taskId &&
        event.data.childRunId === data.childRunId &&
        (type.includes("evaluation")
          ? event.data.attemptNumber ===
            (data as Record<string, unknown>).attemptNumber
          : true),
    );
    if (duplicate) return;
    parent.events.push({
      sequence: parent.events.length + 1,
      type,
      at: this.now().toISOString(),
      data,
    });
  }

  private sameCoordinate(
    left: WorkflowTaskCoordinate,
    right: WorkflowTaskCoordinate,
  ): boolean {
    return (
      left.parentRunId === right.parentRunId &&
      left.stateId === right.stateId &&
      left.visitNumber === right.visitNumber &&
      left.taskId === right.taskId
    );
  }

  private sameReservation(
    left: NonNullable<RunRecord["childRunReservations"]>[number],
    right: NonNullable<RunRecord["childRunReservations"]>[number],
  ): boolean {
    return (
      this.sameCoordinate(left.coordinate, right.coordinate) &&
      left.childRunId === right.childRunId &&
      left.workflowId === right.workflowId &&
      left.workflowSnapshotIdentity === right.workflowSnapshotIdentity &&
      JSON.stringify(left.resolvedWith) === JSON.stringify(right.resolvedWith)
    );
  }
}

function isWorkflow(value: unknown): value is WorkflowWorkDefinition {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: string }).type === "workflow"
  );
}

function resolveBindings(
  bindings: Record<
    string,
    import("../../ports/project-definitions.js").JsonBindingDefinition
  >,
  item?: import("../../domain/execution/run.js").JsonValue,
): Record<string, import("../../domain/execution/run.js").JsonValue> {
  const resolve = (
    value: import("../../ports/project-definitions.js").JsonBindingDefinition,
  ): import("../../domain/execution/run.js").JsonValue => {
    if (value === "$item") {
      if (item === undefined)
        throw new Error("$item requires a dynamic work item");
      return structuredClone(item);
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, resolve(entry)]),
      );
    return value;
  };
  return Object.fromEntries(
    Object.entries(bindings).map(([key, value]) => [key, resolve(value)]),
  );
}
