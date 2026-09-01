import type {
  AttemptFailure,
  AttemptRecord,
  DocumentRecord,
  JsonValue,
  RunRecord,
  StructuredOutputRecord,
  TaskRecord,
  VisitRecord,
} from "../../domain/execution/run.js";
import type {
  WorkflowTaskCoordinate,
  WorkflowTaskEnvelope,
  WorkflowTaskExecutionRecord,
} from "../../domain/execution/workflow-task.js";
import { transitionWorkflowTask } from "../../domain/execution/workflow-task.js";
import type {
  EffectiveExecutionDefinition,
  WorkflowWorkDefinition,
} from "../../ports/project-definitions.js";
import {
  ResultValidationError,
  type RunRepository,
} from "../../ports/run-repository.js";
import type {
  TaskExecution,
  TaskExecutor,
  TaskLaunch,
} from "../../ports/task-executor.js";
import { TaskExecutorError } from "../../ports/task-executor.js";

export interface WorkflowTaskEvaluationContext {
  resolvedWith: Record<string, JsonValue>;
  childRunId: string;
  workflowId: string;
  objective: string;
  terminalPath: readonly string[];
  child: {
    status: RunRecord["status"];
    visits: RunRecord["visits"];
    attempts: AttemptRecord[];
    errors: Array<AttemptFailure | JsonValue>;
    documents: DocumentRecord[];
    structuredOutputs: StructuredOutputRecord[];
    definition: EffectiveExecutionDefinition;
  };
  parent: {
    runId: string;
    stateId: string;
    visitNumber: number;
    taskId: string;
  };
}

export interface EvaluateWorkflowTaskRequest {
  parent: RunRecord;
  coordinate: WorkflowTaskCoordinate;
  child: RunRecord;
  childDefinition: EffectiveExecutionDefinition;
  work: WorkflowWorkDefinition;
  resolvedWith: Record<string, JsonValue>;
  terminalPath?: readonly string[];
  signal?: AbortSignal;
}

export type WorkflowTaskEvaluationResult = {
  envelope: WorkflowTaskEnvelope;
  attempt: AttemptRecord;
  documents: DocumentRecord[];
  context: WorkflowTaskEvaluationContext;
};

const evaluatorTaskId = (coordinate: WorkflowTaskCoordinate) =>
  `${coordinate.taskId}__evaluation`;

export class WorkflowTaskEvaluator {
  constructor(
    private readonly runs: RunRepository,
    private readonly executor: TaskExecutor,
    private readonly now: () => Date,
    private readonly wait: (
      milliseconds: number,
      signal?: AbortSignal,
    ) => Promise<void>,
    private readonly makeId: () => string = () => cryptoRandomId(),
  ) {}

  async evaluate(
    request: EvaluateWorkflowTaskRequest,
  ): Promise<WorkflowTaskEvaluationResult> {
    const wrapper = this.wrapper(request.parent, request.coordinate);
    if (wrapper.phase === "child_running") {
      wrapper.phase = transitionWorkflowTask(wrapper.phase, "evaluating");
      await this.runs.save(request.parent);
    } else if (wrapper.phase !== "evaluating")
      throw new Error(`Workflow wrapper is not evaluable: ${wrapper.phase}`);
    if (
      request.child.status !== "succeeded" &&
      request.child.status !== "failed"
    )
      throw new Error("Workflow child is not terminal");

    const context = this.context(request);
    const artifacts = [
      ...context.child.documents.map((document) => ({
        kind: "document" as const,
        path: document.durablePath,
        sha256: document.sha256,
      })),
      ...context.child.structuredOutputs.map((output) => ({
        kind: "structured_output" as const,
        path: output.durablePath,
        sha256: output.sha256,
      })),
    ];
    if (this.runs.verifyEvaluationArtifacts)
      await this.runs.verifyEvaluationArtifacts(artifacts);
    const contextRecord = this.runs.stageWorkflowTaskEvaluationContext
      ? await this.runs.stageWorkflowTaskEvaluationContext({
          parent: request.parent,
          coordinate: request.coordinate,
          resolvedWith: request.resolvedWith,
          childRunId: request.child.id,
          context: serializeContext(context),
          artifacts,
        })
      : { path: "", sha256: "" };

    const visit = this.parentVisit(request.parent, request.coordinate);
    const evaluationTask: TaskRecord = {
      id: evaluatorTaskId(request.coordinate),
      attempts: wrapper.evaluationAttempts,
    };
    let lastFailure: AttemptFailure | undefined;
    for (let number = 1; number <= 3; number += 1) {
      const attempt = this.existingOrNewAttempt(evaluationTask, number);
      const paths = await this.runs.prepareAttempt(
        request.parent,
        visit,
        evaluationTask,
        number,
      );
      Object.assign(attempt, paths);
      attempt.contextPath = contextRecord.path;
      attempt.status = "launching";
      attempt.startedAt ??= this.now().toISOString();
      attempt.deadlineAt ??= new Date(
        Date.parse(attempt.startedAt) + 30 * 60_000,
      ).toISOString();
      wrapper.evaluationAttempts = evaluationTask.attempts;
      await this.runs.save(request.parent);

      try {
        const recovered = await this.recoverAttempt(request, attempt);
        const execution =
          recovered ??
          (await this.executeAttempt(
            request,
            attempt,
            contextRecord.path,
            context,
            number,
          ));
        attempt.executor = execution.references;
        attempt.logs = execution.logs;
        const result = await this.runs.readResult(
          attempt.resultPath,
          attempt.outputDirectory,
          ["succeeded", "failed"],
        );
        const documents = await this.runs.stageDocuments(
          request.parent,
          visit,
          this.wrapperTask(request.parent, request.coordinate),
          attempt.outputDirectory,
          result.documents,
        );
        attempt.status = "succeeded";
        attempt.outcome = result.outcome;
        attempt.error = result.error;
        attempt.documents = documents;
        const envelope: WorkflowTaskEnvelope = {
          id: request.coordinate.taskId,
          childRunId: request.child.id,
          status: result.outcome as "succeeded" | "failed",
          outputs: await this.outputs(context.child.structuredOutputs),
          documents: [...context.child.documents, ...documents],
          ...(result.error === undefined ? {} : { error: result.error }),
        };
        if (this.runs.commitWorkflowTaskResult)
          await this.runs.commitWorkflowTaskResult({
            parent: request.parent,
            coordinate: request.coordinate,
            attempt,
            envelope,
            documents,
            events: [
              {
                sequence: 0,
                type: "workflow_task_evaluated",
                at: this.now().toISOString(),
                data: {
                  childRunId: request.child.id,
                  status: envelope.status,
                  attemptNumber: attempt.number,
                },
              },
            ],
          });
        return { envelope, attempt, documents, context };
      } catch (error) {
        lastFailure = failure(error);
        attempt.status = "failed";
        attempt.failure = lastFailure;
        await this.runs.save(request.parent);
        if (number === 3) throw error;
        await this.wait(5_000, request.signal);
      }
    }
    throw new Error(lastFailure?.message ?? "Evaluator failed");
  }

  private async recoverAttempt(
    request: EvaluateWorkflowTaskRequest,
    attempt: AttemptRecord,
  ): Promise<TaskExecution | undefined> {
    if (!attempt.executor || !this.executor.recover) return undefined;
    const observation = await this.executor.recover(
      attempt.id,
      attempt.executor,
      request.parent.projectRoot,
      attempt.resultPath,
      {
        runId: request.parent.id,
        stateId: request.coordinate.stateId,
        visitNumber: request.coordinate.visitNumber,
        taskId: request.coordinate.taskId,
        attemptNumber: attempt.number,
      },
    );
    if (observation.status === "completed")
      return { references: observation.references, logs: observation.logs };
    if (observation.status === "active") {
      for (;;) {
        const status = await this.executor.reconcile(
          observation.references,
          request.parent.projectRoot,
        );
        if (status !== "active") break;
        await this.wait(100, request.signal);
      }
    }
    throw new TaskExecutorError(
      `Evaluator attempt ${attempt.id} could not be recovered (${observation.status})`,
    );
  }

  private async executeAttempt(
    request: EvaluateWorkflowTaskRequest,
    attempt: AttemptRecord,
    contextPath: string,
    context: WorkflowTaskEvaluationContext,
    number: number,
  ): Promise<TaskExecution> {
    const launch: TaskLaunch = {
      identity: attempt.id,
      projectWorkspace: request.parent.projectRoot,
      contextPath,
      outputDirectory: attempt.outputDirectory,
      resultPath: attempt.resultPath,
      instructions: evaluatorInstructions(),
      prompt: request.work.evaluator.prompt,
      allowedOutcomes: ["succeeded", "failed"],
      runtime: request.work.evaluator.runtime,
      model: request.work.evaluator.model,
      reasoning: request.work.evaluator.reasoning,
      timeoutMs: 30 * 60_000,
      attemptNumber: number,
      signal: request.signal,
      diagnosticContext: {
        runId: request.parent.id,
        stateId: request.coordinate.stateId,
        visitNumber: request.coordinate.visitNumber,
        taskId: request.coordinate.taskId,
        attemptNumber: number,
      },
    };
    void context;
    let references: TaskExecution["references"] | undefined;
    const execution = this.executor.execute(launch, async (value) => {
      references = value;
      attempt.executor = value;
      attempt.status = "running";
      await this.runs.save(request.parent);
    });
    const timeout = this.wait(30 * 60_000, request.signal).then(() => {
      throw new TaskExecutorError("Evaluator attempt timed out");
    });
    try {
      return await Promise.race([execution, timeout]);
    } catch (error) {
      if (references) {
        await this.executor.cancel(references, request.parent.projectRoot);
        await this.reconcile(references, request.parent.projectRoot);
      }
      throw error;
    }
  }

  private async reconcile(
    references: TaskExecution["references"],
    workspace: string,
  ): Promise<void> {
    for (;;) {
      const status = await this.executor.reconcile(references, workspace);
      if (status !== "active") return;
      await this.wait(100);
    }
  }

  private existingOrNewAttempt(
    task: TaskRecord,
    number: number,
  ): AttemptRecord {
    const existing = task.attempts.find(
      (candidate) => candidate.number === number,
    );
    if (existing) return existing;
    const attempt: AttemptRecord = {
      id: `evaluation:${this.makeId()}:${number}`,
      number,
      status: "launching",
      controlWorkspace: "",
      contextPath: "",
      outputDirectory: "",
      resultPath: "",
      logs: { stdout: "", stderr: "" },
      documents: [],
    };
    task.attempts.push(attempt);
    return attempt;
  }

  private context(
    request: EvaluateWorkflowTaskRequest,
  ): WorkflowTaskEvaluationContext {
    const visits = request.child.visits;
    return {
      resolvedWith: structuredClone(request.resolvedWith),
      childRunId: request.child.id,
      workflowId: request.child.workflowId,
      objective: request.work.evaluator.prompt,
      terminalPath:
        request.terminalPath ??
        visits.map((visit) => `${visit.stateId}:${visit.number}`),
      child: {
        status: request.child.status,
        visits: structuredClone(visits),
        attempts: visits.flatMap((visit) =>
          visit.type === "agent"
            ? visit.task.attempts
            : visit.tasks.flatMap((task) => task.attempts),
        ),
        errors: visits.flatMap((visit) =>
          visit.type === "agent"
            ? visit.task.attempts.flatMap((attempt) =>
                attempt.failure ? [attempt.failure] : [],
              )
            : visit.tasks.flatMap((task) =>
                task.attempts.flatMap((attempt) =>
                  attempt.failure ? [attempt.failure] : [],
                ),
              ),
        ),
        documents: structuredClone(request.child.documents),
        structuredOutputs: structuredClone(
          request.child.structuredOutputs ?? [],
        ),
        definition: structuredClone(request.childDefinition),
      },
      parent: {
        runId: request.coordinate.parentRunId,
        stateId: request.coordinate.stateId,
        visitNumber: request.coordinate.visitNumber,
        taskId: request.coordinate.taskId,
      },
    };
  }

  private async outputs(outputs: readonly StructuredOutputRecord[]) {
    const values = await Promise.all(
      outputs.map(
        async (output) =>
          [
            output.name,
            {
              stateId: output.stateId,
              visitNumber: output.visitNumber,
              name: output.name,
              value: this.runs.readStructuredOutput
                ? await this.runs.readStructuredOutput(output)
                : null,
            },
          ] as const,
      ),
    );
    return Object.fromEntries(values);
  }

  private parentVisit(
    parent: RunRecord,
    coordinate: WorkflowTaskCoordinate,
  ): VisitRecord {
    const visit = parent.visits.find(
      (candidate) =>
        candidate.type === "parallel" &&
        candidate.stateId === coordinate.stateId &&
        candidate.number === coordinate.visitNumber,
    );
    if (!visit) throw new Error("Parent wrapper visit is missing");
    return visit;
  }

  private wrapper(
    parent: RunRecord,
    coordinate: WorkflowTaskCoordinate,
  ): WorkflowTaskExecutionRecord {
    const visit = this.parentVisit(parent, coordinate);
    if (visit.type !== "parallel")
      throw new Error("Parent wrapper visit is not parallel");
    const task = visit.tasks.find(
      (candidate) => candidate.id === coordinate.taskId,
    );
    if (!task || task.execution?.type !== "workflow")
      throw new Error("Workflow wrapper is missing");
    return task.execution;
  }

  private wrapperTask(
    parent: RunRecord,
    coordinate: WorkflowTaskCoordinate,
  ): TaskRecord {
    const visit = this.parentVisit(parent, coordinate);
    if (visit.type !== "parallel")
      throw new Error("Parent wrapper visit is not parallel");
    const task = visit.tasks.find(
      (candidate) => candidate.id === coordinate.taskId,
    );
    if (!task) throw new Error("Workflow wrapper task is missing");
    return task;
  }
}

function evaluatorInstructions(): string {
  return "Evaluate the supplied immutable child workflow evidence and write only the required result contract.";
}

function serializeContext(context: WorkflowTaskEvaluationContext): string {
  return `# Workflow task evaluation context\n\n${JSON.stringify(context, null, 2)}\n`;
}

function failure(error: unknown): AttemptFailure {
  if (error instanceof ResultValidationError)
    return { code: error.code, message: error.message };
  return {
    code: error instanceof TaskExecutorError ? error.code : "evaluator_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function cryptoRandomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
