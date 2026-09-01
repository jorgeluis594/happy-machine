import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkflowBindings } from "../src/domain/execution/parallel-task-materialization.js";
import type { RunRecord } from "../src/domain/execution/run.js";
import { FilesystemProjectDefinitions } from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";
import { FilesystemRunRepository } from "../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-child-run-"));
  await mkdir(path.join(root, "agents"));
  await writeFile(path.join(root, "agents", "worker.md"), "Work\n");
  await writeFile(
    path.join(root, "happy-machine.yaml"),
    "version: 1\nagents:\n  worker:\n    instructions: agents/worker.md\ndefaults:\n  max_attempts: 1\n",
  );
  const workflowPath = path.join(root, "workflow.yaml");
  await writeFile(
    workflowPath,
    "version: 1\nid: child\ninitial_state: start\nstates:\n  start:\n    type: agent\n    agent: worker\n    prompt: Work\n    outcomes:\n      done: $succeeded\n",
  );
  const definitions = new FilesystemProjectDefinitions();
  const definition = await definitions.load(workflowPath, root);
  const repository = new FilesystemRunRepository();
  const snapshot = await repository.createSnapshot({
    runId: "parent",
    projectRoot: root,
    workflowId: definition.workflowId,
    source: definition.snapshotSource,
  });
  const parent: RunRecord = {
    id: "parent",
    workflowId: definition.workflowId,
    workflowPath,
    projectRoot: root,
    definitionSnapshot: snapshot.record,
    status: "running",
    createdAt: "2026-09-01T00:00:00.000Z",
    deadlineAt: "2026-09-02T00:00:00.000Z",
    transitionCount: 0,
    visits: [
      {
        type: "parallel",
        stateId: "fanout",
        number: 1,
        contextPath: "",
        tasks: [
          {
            id: "one",
            status: "queued",
            attempts: [],
            documents: [],
            workspace: { mode: "direct", path: root },
          },
        ],
      },
    ],
    documents: [],
    events: [],
  };
  await repository.save(parent);
  return { root, repository, parent, definition };
}

describe("workflow child persistence", () => {
  it("reserves one stable identity and rejects incompatible intent", async () => {
    const setup = await fixture();
    const coordinate = {
      parentRunId: "parent",
      stateId: "fanout",
      visitNumber: 1,
      taskId: "one",
    };
    const request = {
      projectRoot: setup.root,
      parentRunId: "parent",
      coordinate,
      workflowId: "child",
      workflowSnapshotIdentity: setup.parent.definitionSnapshot.identity,
      resolvedWith: { item: { id: "one" } },
    };
    const first = await setup.repository.reserveChildRun(request);
    const second = await setup.repository.reserveChildRun(request);
    expect(second).toEqual(first);
    await expect(
      setup.repository.reserveChildRun({
        ...request,
        resolvedWith: { item: { id: "changed" } },
      }),
    ).rejects.toThrow(/conflicts/);
  });

  it("creates and reloads a child without rereading project files", async () => {
    const setup = await fixture();
    const coordinate = {
      parentRunId: "parent",
      stateId: "fanout",
      visitNumber: 1,
      taskId: "one",
    };
    const request = {
      projectRoot: setup.root,
      parentRunId: "parent",
      coordinate,
      workflowId: "child",
      workflowSnapshotIdentity: setup.parent.definitionSnapshot.identity,
      resolvedWith: { item: { id: "one", nested: true } },
      workflowDefinition: setup.definition,
      parentSnapshot: setup.parent.definitionSnapshot,
      createdAt: setup.parent.createdAt,
      deadlineAt: setup.parent.deadlineAt,
    };
    const first = await setup.repository.getOrCreateChildRun(request);
    await writeFile(
      path.join(setup.root, "workflow.yaml"),
      "not a workflow anymore\n",
    );
    const second = await setup.repository.getOrCreateChildRun(request);
    expect(second.id).toBe(first.id);
    expect(second.parent).toEqual({
      runId: "parent",
      ...coordinateWithoutParent(coordinate),
    });
    expect(
      await readFile(
        path.join(
          first.projectRoot,
          ".happy-machine",
          "runs",
          first.id,
          "context.md",
        ),
        "utf8",
      ),
    ).toContain('"nested": true');
    expect(
      await readFile(
        path.join(
          first.projectRoot,
          ".happy-machine",
          "runs",
          first.id,
          "snapshot",
          "definition",
          "effective.json",
        ),
        "utf8",
      ),
    ).toContain('"workflowId": "child"');
  });

  it("keeps literal and nested dynamic bindings immutable in context", () => {
    expect(
      resolveWorkflowBindings(
        { literal: 1, nested: { selected: "$item" } },
        { id: "a" },
      ),
    ).toEqual({ literal: 1, nested: { selected: { id: "a" } } });
  });
});

function coordinateWithoutParent(coordinate: {
  parentRunId: string;
  stateId: string;
  visitNumber: number;
  taskId: string;
}) {
  return {
    stateId: coordinate.stateId,
    visitNumber: coordinate.visitNumber,
    taskId: coordinate.taskId,
  };
}
