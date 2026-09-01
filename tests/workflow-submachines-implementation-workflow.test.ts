import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemProjectDefinitions } from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";

const taskPaths = [
  "docs/tasks/workflow-submachines/01-prepare-parallel-work-for-submachines.md",
  "docs/tasks/workflow-submachines/02-register-and-snapshot-reusable-workflows.md",
  "docs/tasks/workflow-submachines/03-persist-parent-child-runs-idempotently.md",
  "docs/tasks/workflow-submachines/04-control-child-workflow-processes.md",
  "docs/tasks/workflow-submachines/05-evaluate-child-workflow-results.md",
  "docs/tasks/workflow-submachines/06-execute-workflow-submachines-in-parallel.md",
  "docs/tasks/workflow-submachines/07-recover-and-cancel-workflow-submachines.md",
  "docs/tasks/workflow-submachines/08-observe-and-certify-workflow-submachines.md",
] as const;

describe("workflow submachines implementation workflow", () => {
  it("loads the sequential direct-workspace definition with Luna medium", async () => {
    const root = path.resolve(".");
    const definition = await new FilesystemProjectDefinitions().load(
      "workflows/workflow-submachines.yaml",
      root,
    );

    expect(definition).toMatchObject({
      projectRoot: root,
      workflowId: "workflow-submachines",
      initialState: "task_01",
      workspaceMode: "direct",
      executorType: "orca",
      agents: {
        workflow_submachines_implementation: {
          runtime: "codex",
          model: "gpt-5.6-luna",
          reasoning: "medium",
        },
      },
    });

    expect(Object.keys(definition.states)).toEqual(
      taskPaths.map((_, index) => `task_${String(index + 1).padStart(2, "0")}`),
    );
  });

  it("assigns each task path once and advances only after completion", async () => {
    const definition = await new FilesystemProjectDefinitions().load(
      "workflows/workflow-submachines.yaml",
      path.resolve("."),
    );

    for (const [index, taskPath] of taskPaths.entries()) {
      const stateId = `task_${String(index + 1).padStart(2, "0")}`;
      const state = definition.states[stateId];
      if (!state || state.type !== "agent")
        throw new Error(`Expected normal agent state ${stateId}`);

      expect(state.agent).toMatchObject({
        id: "workflow_submachines_implementation",
        runtime: "codex",
        model: "gpt-5.6-luna",
        reasoning: "medium",
      });
      expect(state.prompt).toBe(
        `/goal implementa la siguiente tarea ${taskPath}`,
      );
      expect(state.outcomes).toEqual({
        completed:
          index === taskPaths.length - 1
            ? "$succeeded"
            : `task_${String(index + 2).padStart(2, "0")}`,
        failed: stateId,
      });
    }
  });

  it("keeps implementation and validation discipline in shared instructions", async () => {
    const instructions = await readFile(
      path.resolve("agents/workflow-submachines-implementation.md"),
      "utf8",
    );

    expect(instructions).toContain("Complete only the task assigned");
    expect(instructions).toContain("Treat earlier numbered tasks");
    expect(instructions).toContain("preserve unrelated user changes");
    expect(instructions).toContain("acceptance criteria");
    expect(instructions).toContain("commit only after");
    expect(instructions).toContain("Return `completed` only after");
  });
});
