import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkflowBindings } from "../src/domain/execution/parallel-task-materialization.js";
import type { RunRecord } from "../src/domain/execution/run.js";
import { WorkflowTaskCoordinator } from "../src/application/services/workflow-task-coordinator.js";
import { FilesystemProjectDefinitions } from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";
import { FilesystemRunRepository } from "../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";

async function fixture(taskIds: readonly string[] = ["one"]) {
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
        tasks: taskIds.map((id) => ({
          id,
          status: "queued",
          attempts: [],
          documents: [],
          workspace: { mode: "direct", path: root },
          dynamic: {
            workItem: { id },
            source: { stateId: "plan", visitNumber: 1, outputName: "items" },
          },
        })),
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
    await expect(
      setup.repository.reserveChildRun({
        ...request,
        provenance: {
          runId: "different-parent",
          stateId: "fanout",
          visitNumber: 1,
          taskId: "one",
        },
      }),
    ).rejects.toThrow(/provenance/);
  });

  it("atomically reserves an ordered dynamic batch and reconstructs wrappers", async () => {
    const ids = ["one", "two", "three", "four", "five"];
    const setup = await fixture(ids);
    const requests = ids.map((taskId) => ({
      projectRoot: setup.root,
      parentRunId: setup.parent.id,
      coordinate: {
        parentRunId: setup.parent.id,
        stateId: "fanout",
        visitNumber: 1,
        taskId,
      },
      workflowId: "child",
      workflowSnapshotIdentity: setup.parent.definitionSnapshot.identity,
      resolvedWith: { item: { id: taskId } },
    }));

    const first = await setup.repository.reserveChildRuns(requests);
    const second = await setup.repository.reserveChildRuns(requests);
    expect(second).toEqual(first);
    expect(first.map((reservation) => reservation.coordinate.taskId)).toEqual(
      ids,
    );
    expect(
      first.every((reservation) =>
        /^child_[0-9a-f]{32}$/.test(reservation.childRunId),
      ),
    ).toBe(true);

    const interrupted = (await setup.repository.load(setup.root, "parent")).run;
    const visit = interrupted.visits[0];
    if (visit.type !== "parallel") throw new Error("parallel fixture expected");
    expect(visit.tasks.every((task) => task.execution === undefined)).toBe(
      true,
    );
    const coordinator = new WorkflowTaskCoordinator(
      setup.repository,
      undefined as never,
      undefined as never,
      () => new Date("2026-09-01T00:00:00.000Z"),
      () => Promise.resolve(),
    );
    await coordinator.prepareParallel(
      interrupted,
      visit,
      Object.fromEntries(
        ids.map((id) => [
          id,
          {
            type: "workflow" as const,
            workflowId: "child",
            with: { item: "$item" as const },
            workflow: setup.definition,
            evaluator: undefined as never,
          },
        ]),
      ),
    );
    const recovered = (await setup.repository.load(setup.root, "parent")).run;
    const recoveredVisit = recovered.visits[0];
    if (recoveredVisit.type !== "parallel")
      throw new Error("parallel fixture expected");
    expect(
      recoveredVisit.tasks.map((task) =>
        task.execution?.type === "workflow"
          ? task.execution.childRunId
          : undefined,
      ),
    ).toEqual(first.map((reservation) => reservation.childRunId));
    expect(recovered.childRunReservations).toEqual(first);
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
