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

    const definition = await new FilesystemProjectDefinitions().load(
      "workflows/delivery.yaml",
      root,
    );

    expect(definition).toMatchObject({
      workflowId: "delivery",
      initialState: "research",
      workspaceMode: "direct",
      agents: {
        delivery: { model: "local-default-model" },
        qa: { model: "local-qa-model" },
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
            model: "local-implementation-model",
          },
        },
        qa: {
          agent: { id: "qa", model: "local-qa-model" },
          outcomes: {
            passed: "create_pr",
            failed: "implementation",
          },
        },
        create_pr: { outcomes: { opened: "$succeeded" } },
      },
    });
  });
});
