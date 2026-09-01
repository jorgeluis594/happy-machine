import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemProjectDefinitions } from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";

const taskTitles = [
  "Define the technology-independent contracts and error model",
  "Serialize an observable conversation into safe Markdown",
  "Build and validate the analysis and generation prompts",
  "Create a deterministic fake Codex executable",
  "Implement the private filesystem capture store",
  "Implement exclusive create-skill ownership",
  "Implement the demonstration capture stage",
  "Implement isolated demonstration analysis",
  "Implement the generation launch stage",
  "Orchestrate the complete CreateSkill use case with fakes",
  "Implement the Codex JSON-RPC control client",
  "Implement Codex process and terminal lifecycle management",
  "Map Codex conversations without leaking vendor data",
  "Assemble the Codex app-server session adapter",
  "Add the standalone create-skill CLI interaction",
  "Wire the feature and prove the successful end-to-end flow",
  "Harden failure, cancellation, privacy, and cleanup behavior",
  "Run release validation and the real Codex smoke test",
] as const;

const autonomousDecision =
  "If any part of this task is underspecified, analyze the viable alternatives and autonomously choose the recommended option.";
const noDefinitionQuestions =
  "Do not ask for assistance defining requirements, design, or implementation.";

describe("create-skill implementation workflow", () => {
  it("loads the approved sequential definition and policies", async () => {
    const root = path.resolve(".");
    const definition = await new FilesystemProjectDefinitions().load(
      "workflows/create-skill-poc.yaml",
      root,
    );

    expect(definition).toMatchObject({
      projectRoot: root,
      workflowId: "create-skill-poc",
      initialState: "task_01",
      workspaceMode: "direct",
      executorType: "orca",
      policies: {
        attemptTimeoutMs: 3_600_000,
        maxAttempts: 3,
        retryDelayMs: 5_000,
        workflowTimeoutMs: 86_400_000,
        maxStateVisits: 3,
        maxTransitions: 54,
        maxConcurrency: 1,
        controllerLeaseMs: 30_000,
      },
      agents: {
        create_skill_implementation: { runtime: "codex" },
      },
    });

    expect(Object.keys(definition.agents)).toEqual([
      "create_skill_implementation",
      "workflow_submachines_implementation",
    ]);
    expect(Object.keys(definition.states)).toEqual(
      taskTitles.map(
        (_, index) => `task_${String(index + 1).padStart(2, "0")}`,
      ),
    );
  });

  it("assigns one English /goal task per state and routes retries sequentially", async () => {
    const root = path.resolve(".");
    const definition = await new FilesystemProjectDefinitions().load(
      "workflows/create-skill-poc.yaml",
      root,
    );

    for (const [index, title] of taskTitles.entries()) {
      const number = String(index + 1).padStart(2, "0");
      const stateId = `task_${number}`;
      const state = definition.states[stateId];
      if (!state || state.type !== "agent")
        throw new Error(`Expected normal agent state ${stateId}`);

      expect(state.agent.id).toBe("create_skill_implementation");
      expect(state.policies).toMatchObject({
        maxAttempts: 3,
        maxConcurrency: 1,
      });
      expect(state.prompt.startsWith(`/goal Implement Task ${number},`)).toBe(
        true,
      );
      expect(state.prompt).toContain(`"${title}"`);
      expect(state.prompt).toContain(
        "docs/superpowers/plans/2026-08-21-create-skill-poc.md",
      );
      expect(state.prompt.match(/Implement Task \d{2}/g)).toHaveLength(1);
      expect(state.prompt).toContain(autonomousDecision);
      expect(state.prompt).toContain(noDefinitionQuestions);
      expect(state.outcomes).toEqual({
        completed:
          index === taskTitles.length - 1
            ? "$succeeded"
            : `task_${String(index + 2).padStart(2, "0")}`,
        failed: stateId,
      });
    }
  });

  it("keeps autonomous decisions and completion discipline in shared instructions", async () => {
    const instructions = await readFile(
      path.resolve("agents/create-skill-implementation.md"),
      "utf8",
    );
    const finalPrompt = (
      await new FilesystemProjectDefinitions().load(
        "workflows/create-skill-poc.yaml",
        path.resolve("."),
      )
    ).states.task_18;
    if (!finalPrompt || finalPrompt.type !== "agent")
      throw new Error("Expected normal agent state task_18");

    expect(instructions).toContain("Complete only the numbered task");
    expect(instructions).toContain("preserve unrelated user changes");
    expect(instructions).toContain(
      "autonomously choose the recommended option",
    );
    expect(instructions).toContain("Do not ask for assistance defining");
    expect(instructions).toContain("Create a coherent commit only after");
    expect(instructions).toContain("Return `completed` only after");
    expect(finalPrompt.prompt).toContain("npm test");
    expect(finalPrompt.prompt).toContain("npm run typecheck");
    expect(finalPrompt.prompt).toContain("npm run lint");
    expect(finalPrompt.prompt).toContain("npm run build");
    expect(finalPrompt.prompt).toContain("real-Codex manual smoke test");
  });
});
