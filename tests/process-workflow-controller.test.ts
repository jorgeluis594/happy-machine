import { PassThrough } from "node:stream";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunRecord } from "../src/domain/execution/run.js";
import type { RunRepository } from "../src/ports/run-repository.js";
import { ProcessWorkflowController } from "../src/infrastructure/outbound/workflow-controller/process/process-workflow-controller.js";

function run(status: RunRecord["status"]): RunRecord {
  return {
    id: "child-1",
    workflowId: "child",
    workflowPath: "child.yaml",
    projectRoot: "/tmp/project",
    definitionSnapshot: {
      identity: "snapshot",
      directory: "/tmp/snapshot",
      manifestPath: "/tmp/snapshot/manifest.json",
      inputs: [],
    },
    status,
    createdAt: "2026-09-01T00:00:00.000Z",
    deadlineAt: "2026-09-02T00:00:00.000Z",
    transitionCount: 0,
    visits: [],
    documents: [],
    events: [],
  };
}

describe("ProcessWorkflowController", () => {
  it("starts the persisted child with an unambiguous, shell-free command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-controller-"));
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let command:
      | { executable: string; args: readonly string[]; options: unknown }
      | undefined;
    const controller = new ProcessWorkflowController(
      repository(root, "running"),
      {
        executable: "/usr/bin/node",
        entrypoint: "/app/dist/src/main.js",
        makeId: () => "execution-1",
        spawnProcess: (...spawnArguments) => {
          const [executable, args, options] = spawnArguments;
          command = { executable, args, options };
          return { pid: 42, stdout, stderr, unref() {} } as never;
        },
        processIsAlive: () => true,
      },
    );
    const provenance = {
      projectRoot: root,
      childRunId: "child-1",
      parentRunId: "parent",
    };

    const execution = await controller.start({ ...provenance, provenance });
    expect(execution.identity.executionId).toBe("execution-1");
    expect(command).toMatchObject({
      executable: "/usr/bin/node",
      args: ["/app/dist/src/main.js", "resume", "child-1"],
      options: { cwd: root, shell: false, detached: true },
    });
    expect(await readFile(execution.diagnostics.stdoutPath, "utf8")).toBe("");
  });

  it("recovers by provenance and reports durable terminal status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-controller-"));
    const provenance = {
      projectRoot: root,
      childRunId: "child-1",
      parentRunId: "parent",
    };
    const child = repository(root, "running");
    const controller = new ProcessWorkflowController(child, {
      makeId: () => "execution-1",
      spawnProcess: () =>
        ({
          pid: 42,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          unref() {},
        }) as never,
      processIsAlive: () => true,
    });
    const identity = (await controller.start({ ...provenance, provenance }))
      .identity;
    expect(
      (await controller.recover({ projectRoot: root, provenance })).status,
    ).toBe("active");
    (
      child as { loadChildRun: NonNullable<RunRepository["loadChildRun"]> }
    ).loadChildRun = () =>
      Promise.resolve({ run: run("succeeded"), definition: {} as never });
    expect(
      (await controller.reconcile({ projectRoot: root, identity })).status,
    ).toBe("terminal");
    expect(
      (await controller.reconcile({ projectRoot: root, identity })).status,
    ).toBe("terminal");
  });

  it("cancels repeatedly without starting a replacement process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-controller-"));
    const provenance = { projectRoot: root, childRunId: "child-1" };
    let kills = 0;
    const controller = new ProcessWorkflowController(
      repository(root, "running"),
      {
        makeId: () => "execution-1",
        spawnProcess: () =>
          ({
            pid: 42,
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            unref() {},
          }) as never,
        processIsAlive: () => true,
        killProcess: () => {
          kills += 1;
        },
      },
    );
    const identity = (await controller.start({ ...provenance, provenance }))
      .identity;
    await controller.cancel({ projectRoot: root, identity });
    await controller.cancel({ projectRoot: root, identity });
    expect(kills).toBe(2);
  });
});

function repository(root: string, status: RunRecord["status"]): RunRepository {
  const child = run(status);
  child.projectRoot = root;
  return {
    createSnapshot: () => Promise.reject(new Error("not used")),
    loadChildRun: () =>
      Promise.resolve({ run: child, definition: {} as never }),
    save: () => Promise.resolve(),
    prepareVisitContext: () => Promise.resolve(""),
    prepareAttempt: () =>
      Promise.resolve({
        controlWorkspace: "",
        contextPath: "",
        outputDirectory: "",
        resultPath: "",
      }),
    readResult: () => Promise.resolve({ outcome: "", documents: [] }),
    stageDocuments: () => Promise.resolve([]),
  };
}
