import { describe, expect, it } from "vitest";
import {
  canJoinWorkflowTasks,
  reserveWorkflowChild,
  sameWorkflowTaskCoordinate,
  settleWorkflowTask,
  transitionWorkflowTask,
  workflowTaskEvaluatorPolicy,
  type WorkflowTaskExecutionRecord,
} from "../src/domain/execution/workflow-task.js";
import { materializeParallelTasks } from "../src/domain/execution/parallel-task-materialization.js";

const coordinate = {
  parentRunId: "parent",
  stateId: "fan-out",
  visitNumber: 1,
  taskId: "item-1",
};

function workflowTask(
  phase: WorkflowTaskExecutionRecord["phase"] = "queued",
): WorkflowTaskExecutionRecord {
  return {
    type: "workflow",
    phase,
    coordinate,
    childRunId: "child-1",
    resolvedWith: { item: { id: "item-1" } },
    evaluationAttempts: [],
  };
}

describe("workflow task domain seam", () => {
  it("exposes the fixed evaluator policy", () => {
    expect(workflowTaskEvaluatorPolicy).toEqual({
      attemptTimeoutMs: 1_800_000,
      maxAttempts: 3,
      retryDelayMs: 5_000,
    });
  });

  it("accepts only the wrapper phase transitions", () => {
    expect(transitionWorkflowTask("queued", "child_running")).toBe(
      "child_running",
    );
    expect(() => transitionWorkflowTask("queued", "evaluating")).toThrow();
    expect(() => transitionWorkflowTask("succeeded", "failed")).toThrow();
  });

  it("rejects changed child identity and coordinate", () => {
    expect(sameWorkflowTaskCoordinate(coordinate, { ...coordinate })).toBe(
      true,
    );
    expect(() =>
      reserveWorkflowChild(workflowTask(), "other-child", coordinate),
    ).toThrow();
    expect(() =>
      reserveWorkflowChild(workflowTask(), "child-1", {
        ...coordinate,
        taskId: "other",
      }),
    ).toThrow();
  });

  it("settles only evaluating wrappers and joins terminal wrappers", () => {
    const task = workflowTask("evaluating");
    const envelope = {
      id: "item-1",
      childRunId: "child-1",
      status: "succeeded" as const,
      outputs: {},
      documents: [],
    };
    expect(settleWorkflowTask(task, envelope).phase).toBe("succeeded");
    expect(canJoinWorkflowTasks([workflowTask("succeeded")])).toBe(true);
    expect(canJoinWorkflowTasks([workflowTask("child_running")])).toBe(false);
    expect(() => settleWorkflowTask(workflowTask(), envelope)).toThrow();
  });

  it("materializes static and dynamic queues with cloned immutable items", () => {
    const item = { id: "item-1", value: { title: "first" } };
    const dynamic = materializeParallelTasks({
      taskDefinitions: {},
      projectRoot: "/project",
      workspaceMode: "direct",
      dynamicSource: { stateId: "plan", visitNumber: 1, outputName: "items" },
      workItems: [item],
    });
    item.value.title = "changed";
    expect(dynamic[0].dynamic?.workItem.value).toEqual({ title: "first" });
    expect(
      materializeParallelTasks({
        taskDefinitions: {
          first: {
            id: "first",
            agent: { id: "agent", instructions: "", runtime: "codex" },
            prompt: "prompt",
            policies: {
              attemptTimeoutMs: 1,
              maxAttempts: 1,
              retryDelayMs: 0,
              workflowTimeoutMs: 1,
              maxStateVisits: 1,
              maxTransitions: 1,
              maxConcurrency: 1,
              controllerLeaseMs: 1,
            },
          },
        },
        projectRoot: "/project",
        workspaceMode: "direct",
      }).map((task) => task.id),
    ).toEqual(["first"]);
  });
});
