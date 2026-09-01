import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemProjectDefinitions } from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";

function example(readme: string, name: string): string {
  const marker = `<!-- readme-example:${name} -->`;
  const start = readme.indexOf(marker);
  if (start === -1) throw new Error(`README example not found: ${name}`);
  const match = readme
    .slice(start + marker.length)
    .match(/```\w+\n([\s\S]*?)\n```/);
  if (!match?.[1]) throw new Error(`README example is empty: ${name}`);
  return `${match[1]}\n`;
}

describe("README quick start", () => {
  it("contains project files accepted by the current definition parser", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-readme-"));
    await mkdir(path.join(root, "agents"));
    await mkdir(path.join(root, "workflows"));
    await writeFile(
      path.join(root, "happy-machine.yaml"),
      example(readme, "project"),
    );
    await writeFile(
      path.join(root, "agents", "delivery.md"),
      example(readme, "delivery-agent"),
    );
    await writeFile(
      path.join(root, "agents", "qa.md"),
      example(readme, "qa-agent"),
    );
    await writeFile(
      path.join(root, "workflows", "delivery.yaml"),
      example(readme, "workflow"),
    );
    await writeFile(
      path.join(root, "workflows", "review.yaml"),
      example(readme, "review-workflow"),
    );

    const definition = await new FilesystemProjectDefinitions().load(
      "workflows/delivery.yaml",
      root,
    );

    expect(definition).toMatchObject({
      workflowId: "delivery",
      initialState: "research",
      workspaceMode: "direct",
      agents: {
        delivery: { runtime: "codex" },
        qa: { runtime: "opencode" },
      },
      policies: {
        workflowTimeoutMs: 14_400_000,
        maxStateVisits: 3,
        maxTransitions: 20,
      },
      states: {
        implementation: {
          agent: {
            id: "delivery",
            runtime: "codex",
          },
        },
        qa: {
          agent: { id: "qa", runtime: "opencode" },
          outcomes: {
            passed: "create_pr",
            failed: "implementation",
          },
        },
        create_pr: { outcomes: { opened: "$succeeded" } },
      },
    });
  });

  it("contains valid static and dynamic child-workflow examples", async () => {
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-readme-child-"));
    await mkdir(path.join(root, "agents"));
    await mkdir(path.join(root, "workflows"));
    await writeFile(
      path.join(root, "happy-machine.yaml"),
      example(readme, "project"),
    );
    await writeFile(path.join(root, "agents", "delivery.md"), "delivery\n");
    await writeFile(path.join(root, "agents", "qa.md"), "qa\n");
    await writeFile(
      path.join(root, "workflows", "review.yaml"),
      example(readme, "review-workflow"),
    );

    for (const name of ["static-subworkflows", "dynamic-subworkflows"]) {
      const workflowPath = path.join(root, "workflows", `${name}.yaml`);
      await writeFile(workflowPath, example(readme, name));
      const definition = await new FilesystemProjectDefinitions().load(
        workflowPath,
        root,
      );
      const parallel = Object.values(definition.states).find(
        (state) => state.type === "parallel",
      );
      if (parallel?.type !== "parallel")
        throw new Error("README child-workflow example needs a parallel state");
      if (name === "static-subworkflows") {
        expect(parallel.mode).toBe("static");
        expect(
          Object.values(parallel.tasks).every(
            (task) => task.type === "workflow" && task.workflowId === "review",
          ),
        ).toBe(true);
      } else {
        expect(parallel.mode).toBe("dynamic");
        if (parallel.mode !== "dynamic")
          throw new Error("README dynamic example needs for_each");
        expect(parallel.task).toMatchObject({
          type: "workflow",
          workflowId: "review",
          with: { item: "$item" },
        });
      }
    }
  });
});
