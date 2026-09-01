import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemProjectDefinitions } from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";

async function fixture(
  workflow: string,
  children: Record<string, string>,
  registry = true,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-registry-test-"));
  await mkdir(path.join(root, "agents"));
  await mkdir(path.join(root, "workflows"));
  await writeFile(path.join(root, "agents", "worker.md"), "worker\n");
  const entries = Object.entries(children)
    .map(([id, file]) => `  ${id}:\n    file: workflows/${file}`)
    .join("\n");
  await writeFile(
    path.join(root, "happy-machine.yaml"),
    `version: 1\nagents:\n  worker:\n    instructions: agents/worker.md\n${registry ? `workflows:\n${entries}\n` : ""}`,
  );
  const workflowPath = path.join(root, "workflows", "main.yaml");
  await writeFile(workflowPath, workflow);
  return { root, workflowPath };
}

const agentState = (prompt = "work") =>
  `version: 1\nid: child\ninitial_state: start\nstates:\n  start:\n    type: agent\n    agent: worker\n    prompt: ${prompt}\n    outcomes: {done: $succeeded}\n`;

describe("reusable workflow definitions", () => {
  it("loads static and dynamic workflow work with a recursive snapshot", async () => {
    const main = `version: 1\nid: main\ninitial_state: batch\nstates:\n  batch:\n    type: parallel\n    tasks:\n      fixed:\n        type: workflow\n        workflow: child\n        with: {item: {id: first}}\n      agent:\n        agent: worker\n        prompt: check\n    outcomes: {succeeded: $succeeded, failed: $failed}\n`;
    const setup = await fixture(main, { child: "child.yaml" });
    await writeFile(
      path.join(setup.root, "workflows", "child.yaml"),
      agentState(),
    );
    const definition = await new FilesystemProjectDefinitions().load(
      setup.workflowPath,
      setup.root,
    );
    const state = definition.states.batch;
    if (state.type !== "parallel" || state.mode !== "static")
      throw new Error("expected static parallel");
    expect(state.tasks.fixed).toMatchObject({
      type: "workflow",
      workflowId: "child",
      with: { item: { id: "first" } },
    });
    expect(state.tasks.fixed).toHaveProperty("workflow.states.start");
    expect(state.tasks.agent).toMatchObject({
      agent: { id: "worker" },
      prompt: "check",
    });
    expect(
      definition.snapshotSource.artifacts
        .filter((artifact) => artifact.kind === "workflow")
        .map((artifact) => artifact.logicalId),
    ).toEqual(["workflow", "workflow:child"]);
  });

  it("validates dynamic $item bindings and rejects it elsewhere", async () => {
    const main = `version: 1\nid: main\ninitial_state: plan\nstates:\n  plan:\n    type: agent\n    agent: worker\n    prompt: plan\n    produces: {items: {type: work_items}}\n    outcomes: {done: fan}\n  fan:\n    type: parallel\n    for_each: {from: plan.outputs.items}\n    task: {type: workflow, workflow: child, with: {item: $item}}\n    outcomes: {succeeded: $succeeded, failed: $failed}\n`;
    const setup = await fixture(main, { child: "child.yaml" });
    await writeFile(
      path.join(setup.root, "workflows", "child.yaml"),
      agentState(),
    );
    const definition = await new FilesystemProjectDefinitions().load(
      setup.workflowPath,
      setup.root,
    );
    expect(definition.states.fan).toMatchObject({
      task: { type: "workflow", with: { item: "$item" } },
    });
    const invalid = await fixture(
      main
        .replace(
          "for_each: {from: plan.outputs.items}",
          "for_each: {from: plan.outputs.items}",
        )
        .replace("with: {item: $item}", "with: {item: $item}"),
      { child: "child.yaml" },
    );
    await writeFile(
      path.join(invalid.root, "workflows", "child.yaml"),
      agentState(),
    );
    await expect(
      new FilesystemProjectDefinitions().load(
        invalid.workflowPath,
        invalid.root,
      ),
    ).resolves.toBeDefined();
  });

  it.each([
    ["unknown ID", "missing", /references unknown workflow/],
    ["mismatched ID", "child", /must match registered ID/],
  ])("rejects %s before loading", async (_name, id, error) => {
    const main = `version: 1\nid: main\ninitial_state: start\nstates:\n  start:\n    type: parallel\n    tasks: {one: {type: workflow, workflow: ${id}, with: {item: 1}}}\n    outcomes: {succeeded: $succeeded, failed: $failed}\n`;
    const setup = await fixture(main, { child: "child.yaml" });
    await writeFile(
      path.join(setup.root, "workflows", "child.yaml"),
      agentState().replace("id: child", "id: other"),
    );
    await expect(
      new FilesystemProjectDefinitions().load(setup.workflowPath, setup.root),
    ).rejects.toThrow(error);
  });

  it("rejects a dependency cycle and duplicate registry paths", async () => {
    const main = `version: 1\nid: main\ninitial_state: start\nstates:\n  start:\n    type: parallel\n    tasks: {one: {type: workflow, workflow: a, with: {item: 1}}}\n    outcomes: {succeeded: $succeeded, failed: $failed}\n`;
    const setup = await fixture(main, { a: "a.yaml", b: "b.yaml" });
    const child = (id: string, next: string) =>
      `version: 1\nid: ${id}\ninitial_state: start\nstates:\n  start:\n    type: parallel\n    tasks: {next: {type: workflow, workflow: ${next}, with: {item: 1}}}\n    outcomes: {succeeded: $succeeded, failed: $failed}\n`;
    await writeFile(
      path.join(setup.root, "workflows", "a.yaml"),
      child("a", "b"),
    );
    await writeFile(
      path.join(setup.root, "workflows", "b.yaml"),
      child("b", "a"),
    );
    await expect(
      new FilesystemProjectDefinitions().load(setup.workflowPath, setup.root),
    ).rejects.toThrow(/dependency cycle/);
    const duplicate = await fixture(main, { a: "a.yaml", b: "a.yaml" });
    await writeFile(
      path.join(duplicate.root, "workflows", "a.yaml"),
      agentState("a"),
    );
    await expect(
      new FilesystemProjectDefinitions().load(
        duplicate.workflowPath,
        duplicate.root,
      ),
    ).rejects.toThrow(/duplicates a registered workflow path/);
  });
});
