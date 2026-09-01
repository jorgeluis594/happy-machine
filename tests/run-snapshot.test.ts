import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunRecord } from "../src/domain/execution/run.js";
import { FilesystemProjectDefinitions } from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";
import { FilesystemRunRepository } from "../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";

interface ManifestArtifact {
  kind: string;
  internalPath: string;
  sha256: string;
}

interface SnapshotManifest {
  identity: string;
  artifacts: ManifestArtifact[];
  effectiveDefinition: Record<string, unknown>;
  [key: string]: unknown;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "run-snapshot-test-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "run-snapshot-input-"));
  await mkdir(path.join(root, "agents"));
  await mkdir(path.join(root, "workflows"));
  await writeFile(
    path.join(root, "happy-machine.yaml"),
    `version: 1
agents:
  worker:
    instructions: agents/worker.md
    runtime: opencode
    reasoning: max
defaults:
  max_attempts: 4
`,
  );
  await writeFile(path.join(root, "agents", "worker.md"), "# Original agent\n");
  const workflowPath = path.join(root, "workflows", "workflow.yaml");
  await writeFile(
    workflowPath,
    `version: 1
id: snapshot
initial_state: start
states:
  start:
    type: agent
    agent: worker
    prompt: Original prompt
    outcomes:
      done: $succeeded
`,
  );
  const internalInput = path.join(root, "brief.md");
  const externalInput = path.join(outside, "brief.md");
  await writeFile(internalInput, "internal original\n");
  await writeFile(externalInput, "external original\n");
  return { root, workflowPath, internalInput, externalInput };
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory())
      for (const nested of await files(child))
        result.push(path.posix.join(entry.name, nested));
    else result.push(entry.name);
  }
  return result.sort();
}

describe("filesystem run snapshots", () => {
  it("materializes a complete verifiable snapshot with collision-free inputs", async () => {
    const setup = await fixture();
    const definition = await new FilesystemProjectDefinitions().load(
      setup.workflowPath,
      setup.root,
      [setup.internalInput, setup.externalInput],
    );
    const repository = new FilesystemRunRepository();
    const created = await repository.createSnapshot({
      runId: "run-one",
      projectRoot: setup.root,
      workflowId: definition.workflowId,
      source: definition.snapshotSource,
    });

    expect(created.record.identity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(created.record.inputs).toMatchObject([
      {
        id: "input-0001",
        originalName: "brief.md",
        internalPath: "inputs/input-0001/brief.md",
      },
      {
        id: "input-0002",
        originalName: "brief.md",
        internalPath: "inputs/input-0002/brief.md",
      },
    ]);
    await expect(
      readFile(created.record.inputs[0].durablePath, "utf8"),
    ).resolves.toBe("internal original\n");
    await expect(
      readFile(created.record.inputs[1].durablePath, "utf8"),
    ).resolves.toBe("external original\n");

    const manifest = JSON.parse(
      await readFile(created.record.manifestPath, "utf8"),
    ) as SnapshotManifest;
    const { identity, ...payload } = manifest;
    expect(identity).toBe(`sha256:${hash(JSON.stringify(payload))}`);
    for (const artifact of manifest.artifacts) {
      const content = await readFile(
        path.join(
          created.record.directory,
          ...artifact.internalPath.split("/"),
        ),
        "utf8",
      );
      expect(hash(content)).toBe(artifact.sha256);
    }
    const inlinePrompt = manifest.artifacts.find(
      (artifact) => artifact.kind === "inline_prompt",
    )!;
    await expect(
      readFile(
        path.join(
          created.record.directory,
          ...inlinePrompt.internalPath.split("/"),
        ),
        "utf8",
      ),
    ).resolves.toBe("Original prompt");
    expect(manifest.effectiveDefinition).toMatchObject({
      executorType: "orca",
      workspaceMode: "direct",
      agents: { worker: { runtime: "opencode", reasoning: "max" } },
      policies: { maxAttempts: 4 },
      states: {
        start: {
          agent: { runtime: "opencode", reasoning: "max" },
          prompt: "Original prompt",
        },
      },
    });
    expect(await files(created.record.directory)).toEqual([
      "definition/agents/agent-0001/instructions.md",
      "definition/effective.json",
      "definition/happy-machine.yaml",
      "definition/prompts/prompt-0001/prompt.md",
      "definition/workflow.yaml",
      "inputs/input-0001/brief.md",
      "inputs/input-0002/brief.md",
      "manifest.json",
    ]);

    const repeated = await repository.createSnapshot({
      runId: "run-two",
      projectRoot: setup.root,
      workflowId: definition.workflowId,
      source: definition.snapshotSource,
    });
    expect(repeated.record.identity).toBe(created.record.identity);
  });

  it("includes reasoning in snapshot content and identity", async () => {
    const setup = await fixture();
    const definitions = new FilesystemProjectDefinitions();
    const repository = new FilesystemRunRepository();
    const firstDefinition = await definitions.load(
      setup.workflowPath,
      setup.root,
    );
    const first = await repository.createSnapshot({
      runId: "run-reasoning-max",
      projectRoot: setup.root,
      workflowId: firstDefinition.workflowId,
      source: firstDefinition.snapshotSource,
    });

    const projectPath = path.join(setup.root, "happy-machine.yaml");
    await writeFile(
      projectPath,
      (await readFile(projectPath, "utf8")).replace(
        "reasoning: max",
        "reasoning: high",
      ),
    );
    const secondDefinition = await definitions.load(
      setup.workflowPath,
      setup.root,
    );
    const second = await repository.createSnapshot({
      runId: "run-reasoning-high",
      projectRoot: setup.root,
      workflowId: secondDefinition.workflowId,
      source: secondDefinition.snapshotSource,
    });

    expect(first.definition.agents.worker.reasoning).toBe("max");
    expect(second.definition.agents.worker.reasoning).toBe("high");
    expect(second.record.identity).not.toBe(first.record.identity);
  });

  it("includes a resolved Codex model in snapshot content and identity", async () => {
    const setup = await fixture();
    const projectPath = path.join(setup.root, "happy-machine.yaml");
    await writeFile(
      projectPath,
      (await readFile(projectPath, "utf8"))
        .replace("runtime: opencode", "runtime: codex")
        .replace("reasoning: max", "model: gpt-first\n    reasoning: max"),
    );
    const definitions = new FilesystemProjectDefinitions();
    const repository = new FilesystemRunRepository();
    const firstDefinition = await definitions.load(
      setup.workflowPath,
      setup.root,
    );
    const first = await repository.createSnapshot({
      runId: "run-model-first",
      projectRoot: setup.root,
      workflowId: firstDefinition.workflowId,
      source: firstDefinition.snapshotSource,
    });

    await writeFile(
      projectPath,
      (await readFile(projectPath, "utf8")).replace("gpt-first", "gpt-second"),
    );
    const secondDefinition = await definitions.load(
      setup.workflowPath,
      setup.root,
    );
    const second = await repository.createSnapshot({
      runId: "run-model-second",
      projectRoot: setup.root,
      workflowId: secondDefinition.workflowId,
      source: secondDefinition.snapshotSource,
    });

    expect(first.definition.agents.worker.model).toBe("gpt-first");
    expect(first.definition.states.start).toMatchObject({
      agent: { runtime: "codex", model: "gpt-first" },
    });
    expect(second.definition.agents.worker.model).toBe("gpt-second");
    expect(second.record.identity).not.toBe(first.record.identity);
  });

  it("loads legacy snapshots without runtime as Codex and ignores model", async () => {
    const setup = await fixture();
    const definition = await new FilesystemProjectDefinitions().load(
      setup.workflowPath,
      setup.root,
    );
    const repository = new FilesystemRunRepository();
    const created = await repository.createSnapshot({
      runId: "run-legacy",
      projectRoot: setup.root,
      workflowId: definition.workflowId,
      source: definition.snapshotSource,
    });
    const run: RunRecord = {
      id: "run-legacy",
      workflowId: definition.workflowId,
      workflowPath: definition.workflowPath,
      projectRoot: setup.root,
      definitionSnapshot: created.record,
      status: "running",
      createdAt: "2026-08-11T12:00:00.000Z",
      deadlineAt: "2026-08-12T12:00:00.000Z",
      transitionCount: 0,
      visits: [],
      documents: [],
      events: [],
    };
    await writeFile(
      path.join(setup.root, ".happy-machine", "runs", run.id, "run.json"),
      `${JSON.stringify(run, null, 2)}\n`,
    );

    const manifest = JSON.parse(
      await readFile(created.record.manifestPath, "utf8"),
    ) as SnapshotManifest;
    const effective = manifest.effectiveDefinition as {
      agents: Record<string, Record<string, unknown>>;
      states: Record<
        string,
        | { type: "agent"; agent: Record<string, unknown> }
        | {
            type: "parallel";
            tasks: Record<string, { agent: Record<string, unknown> }>;
          }
      >;
    };
    delete effective.agents.worker.runtime;
    delete effective.agents.worker.reasoning;
    effective.agents.worker.model = "legacy-default-model";
    const normal = effective.states.start;
    if (normal.type !== "agent") throw new Error("expected legacy agent state");
    delete normal.agent.runtime;
    delete normal.agent.reasoning;
    normal.agent.model = "legacy-override-model";
    effective.states.legacy_parallel = {
      type: "parallel",
      tasks: {
        check: {
          agent: {
            id: "worker",
            instructions: "# Original agent\n",
            model: "legacy-task-model",
          },
        },
      },
    };
    await writeFile(
      created.record.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const recovered = await repository.load(setup.root, run.id);
    expect(recovered.definition.agents.worker.runtime).toBe("codex");
    expect(recovered.definition.agents.worker.reasoning).toBeUndefined();
    expect(recovered.definition.agents.worker).not.toHaveProperty("model");
    const state = recovered.definition.states.start;
    expect(state.type).toBe("agent");
    if (state.type !== "agent") throw new Error("expected agent state");
    expect(state.agent.runtime).toBe("codex");
    expect(state.agent).not.toHaveProperty("model");
    const parallel = recovered.definition.states.legacy_parallel;
    expect(parallel.type).toBe("parallel");
    if (parallel.type !== "parallel")
      throw new Error("expected legacy parallel state");
    expect(parallel.tasks.check.agent.runtime).toBe("codex");
    expect(parallel.tasks.check.agent).not.toHaveProperty("model");
  });

  it("keeps committed source and context immutable while a new run captures edits", async () => {
    const setup = await fixture();
    const definitions = new FilesystemProjectDefinitions();
    const repository = new FilesystemRunRepository();
    const firstDefinition = await definitions.load(
      setup.workflowPath,
      setup.root,
      [setup.externalInput],
    );
    const first = await repository.createSnapshot({
      runId: "run-first",
      projectRoot: setup.root,
      workflowId: firstDefinition.workflowId,
      source: firstDefinition.snapshotSource,
    });
    const run: RunRecord = {
      id: "run-first",
      workflowId: firstDefinition.workflowId,
      workflowPath: firstDefinition.workflowPath,
      projectRoot: setup.root,
      definitionSnapshot: first.record,
      status: "running",
      createdAt: "2026-08-11T12:00:00.000Z",
      deadlineAt: "2026-08-12T12:00:00.000Z",
      transitionCount: 0,
      documents: [],
      visits: [
        {
          type: "agent",
          stateId: "start",
          number: 1,
          contextPath: "",
          task: { id: "start-task", attempts: [] },
        },
      ],
      events: [],
    };
    const visit = run.visits[0];
    if (visit.type !== "agent") throw new Error("expected agent visit");
    visit.contextPath = await repository.prepareVisitContext(run);
    const originalContext = await readFile(visit.contextPath, "utf8");
    expect(originalContext.match(/^### input-0001$/gm)).toHaveLength(1);
    expect(originalContext).toContain("inputs/input-0001/brief.md");
    expect(originalContext).toContain(first.record.inputs[0].durablePath);
    expect(originalContext).not.toContain(setup.externalInput);

    visit.task.attempts.push({
      id: "attempt-1",
      number: 1,
      status: "launching",
      controlWorkspace: "",
      contextPath: "",
      outputDirectory: "",
      resultPath: "",
      logs: { stdout: "", stderr: "" },
      documents: [],
    });
    const firstAttempt = await repository.prepareAttempt(
      run,
      visit,
      visit.task,
      1,
    );
    visit.task.attempts.push({
      id: "attempt-2",
      number: 2,
      status: "launching",
      controlWorkspace: "",
      contextPath: "",
      outputDirectory: "",
      resultPath: "",
      logs: { stdout: "", stderr: "" },
      documents: [],
    });
    const secondAttempt = await repository.prepareAttempt(
      run,
      visit,
      visit.task,
      2,
    );
    expect(secondAttempt.contextPath).toBe(firstAttempt.contextPath);
    expect(secondAttempt.outputDirectory).not.toBe(
      firstAttempt.outputDirectory,
    );
    await expect(readFile(secondAttempt.contextPath, "utf8")).resolves.toBe(
      originalContext,
    );

    await writeFile(setup.externalInput, "external edited\n");
    await writeFile(
      path.join(setup.root, "agents", "worker.md"),
      "# Edited agent\n",
    );
    await writeFile(
      setup.workflowPath,
      (await readFile(setup.workflowPath, "utf8")).replace(
        "Original prompt",
        "Edited prompt",
      ),
    );
    await expect(
      readFile(first.record.inputs[0].durablePath, "utf8"),
    ).resolves.toBe("external original\n");
    await expect(readFile(firstAttempt.contextPath, "utf8")).resolves.toBe(
      originalContext,
    );

    const secondDefinition = await definitions.load(
      setup.workflowPath,
      setup.root,
      [setup.externalInput],
    );
    const second = await repository.createSnapshot({
      runId: "run-second",
      projectRoot: setup.root,
      workflowId: secondDefinition.workflowId,
      source: secondDefinition.snapshotSource,
    });
    expect(second.record.identity).not.toBe(first.record.identity);
    await expect(
      readFile(second.record.inputs[0].durablePath, "utf8"),
    ).resolves.toBe("external edited\n");
  });

  it("never overwrites an existing run snapshot", async () => {
    const setup = await fixture();
    const definition = await new FilesystemProjectDefinitions().load(
      setup.workflowPath,
      setup.root,
    );
    const repository = new FilesystemRunRepository();
    const request = {
      runId: "run-stable",
      projectRoot: setup.root,
      workflowId: definition.workflowId,
      source: definition.snapshotSource,
    };
    const first = await repository.createSnapshot(request);
    const manifest = await readFile(first.record.manifestPath, "utf8");
    await expect(repository.createSnapshot(request)).rejects.toThrow();
    await expect(readFile(first.record.manifestPath, "utf8")).resolves.toBe(
      manifest,
    );
  });
});
