import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExecuteWorkflow } from "../src/application/use-cases/execute-workflow.js";
import {
  FilesystemProjectDefinitions,
  DefinitionError,
} from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";
import { FilesystemRunRepository } from "../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";
import type { TaskExecutor, TaskLaunch } from "../src/ports/task-executor.js";

const wait = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(
          signal.reason instanceof Error ? signal.reason : new Error("aborted"),
        );
      },
      { once: true },
    );
  });

async function project(workflow: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-dynamic-"));
  await mkdir(path.join(root, "workflows"));
  await mkdir(path.join(root, "agents"));
  await writeFile(path.join(root, "agents", "agent.md"), "Follow the task.\n");
  await writeFile(
    path.join(root, "happy-machine.yaml"),
    `version: 1
agents:
  worker:
    instructions: agents/agent.md
defaults:
  attempt_timeout: 1m
  max_attempts: 1
  retry_delay: 1ms
  workflow_timeout: 1h
  max_state_visits: 10
  max_transitions: 10
  max_concurrency: 2
  controller_lease: 30s
`,
  );
  await writeFile(path.join(root, "workflows", "flow.yaml"), workflow);
  return root;
}

const validWorkflow = `version: 1
id: dynamic
initial_state: plan
states:
  plan:
    type: agent
    agent: worker
    prompt: Plan work.
    produces:
      tasks:
        type: work_items
        max_items: 3
    outcomes:
      completed: implement
  implement:
    type: parallel
    for_each:
      from: plan.outputs.tasks
    task:
      agent: worker
      prompt: Implement the work item.
    max_concurrency: 2
    outcomes:
      succeeded: $succeeded
      failed: $failed
`;

describe("dynamic parallel fan-out", () => {
  it("parses producer outputs and a dynamic task template", async () => {
    const root = await project(validWorkflow);
    const definition = await new FilesystemProjectDefinitions().load(
      "workflows/flow.yaml",
      root,
    );
    expect(definition.states.plan.type).toBe("agent");
    if (definition.states.plan.type !== "agent")
      throw new Error("expected agent");
    expect(definition.states.plan.produces?.tasks).toEqual({
      type: "work_items",
      maxItems: 3,
    });
    const dynamic = definition.states.implement;
    expect(dynamic.type).toBe("parallel");
    if (dynamic.type !== "parallel" || dynamic.mode !== "dynamic")
      throw new Error("expected dynamic parallel");
    expect(dynamic.forEach).toEqual({ stateId: "plan", outputName: "tasks" });
    expect(dynamic.effectiveMaxConcurrency).toBe(2);
  });

  it("rejects a dynamic source that is not a declared work_items output", async () => {
    const root = await project(
      validWorkflow.replace("plan.outputs.tasks", "plan.outputs.missing"),
    );
    await expect(
      new FilesystemProjectDefinitions().load("workflows/flow.yaml", root),
    ).rejects.toThrow(DefinitionError);
  });

  it("defaults max_items and rejects mixed static and dynamic forms", async () => {
    const root = await project(
      validWorkflow.replace("        max_items: 3\n", ""),
    );
    const definition = await new FilesystemProjectDefinitions().load(
      "workflows/flow.yaml",
      root,
    );
    if (definition.states.plan.type !== "agent")
      throw new Error("expected agent");
    expect(definition.states.plan.produces?.tasks.maxItems).toBe(100);

    const mixed = await project(
      validWorkflow.replace(
        "    for_each:\n",
        "    tasks:\n      fixed:\n        agent: worker\n        prompt: Fixed.\n    for_each:\n",
      ),
    );
    await expect(
      new FilesystemProjectDefinitions().load("workflows/flow.yaml", mixed),
    ).rejects.toThrow(/exactly one of tasks/);
  });

  it.each([
    { tasks: [{ id: "same" }, { id: "same" }] },
    { tasks: [{ title: "missing id" }] },
    { tasks: [{ id: "one" }, { id: "two" }, { id: "three" }, { id: "four" }] },
  ])("rejects invalid work_items output %#", async (outputs) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-output-"));
    await mkdir(path.join(root, "output"));
    const resultPath = path.join(root, "result.json");
    await writeFile(
      resultPath,
      JSON.stringify({ outcome: "completed", outputs, documents: [] }),
    );
    await expect(
      new FilesystemRunRepository().readResult(
        resultPath,
        path.join(root, "output"),
        ["completed"],
        { tasks: { type: "work_items", maxItems: 3 } },
      ),
    ).rejects.toMatchObject({ code: "structured_outputs_invalid" });
  });

  it("commits, materializes, and executes ordered isolated work items", async () => {
    const root = await project(validWorkflow);
    const launches: TaskLaunch[] = [];
    const executor: TaskExecutor = {
      async execute(launch, onStarted) {
        launches.push(launch);
        await onStarted({ executionId: `execution-${launches.length}` });
        const result =
          launch.prompt === "Plan work."
            ? {
                outcome: "completed",
                outputs: {
                  tasks: [
                    { id: "alpha", title: "A" },
                    { id: "beta", nested: { ok: true } },
                  ],
                },
                documents: [],
              }
            : { outcome: "succeeded", documents: [] };
        await writeFile(launch.resultPath, JSON.stringify(result));
        return {
          references: { executionId: `execution-${launches.length}` },
          logs: { stdout: "", stderr: "" },
        };
      },
      async cancel() {},
      reconcile() {
        return Promise.resolve("stopped");
      },
    };
    const run = await new ExecuteWorkflow(
      new FilesystemProjectDefinitions(),
      new FilesystemRunRepository(),
      executor,
      () => new Date("2026-08-26T12:00:00.000Z"),
      () => "dynamic-test",
      wait,
    ).execute({
      workflowPath: "workflows/flow.yaml",
      currentDirectory: root,
      onRunAllocated() {},
    });

    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
    expect(run.structuredOutputs).toHaveLength(1);
    const visit = run.visits[1];
    expect(visit.type).toBe("parallel");
    if (visit.type !== "parallel") throw new Error("expected parallel");
    expect(visit.tasks.map((task) => task.id)).toEqual(["alpha", "beta"]);
    expect(
      run.events.some((event) => event.type === "dynamic_tasks_materialized"),
    ).toBe(true);
    const workerContexts = new Map<string, string>();
    for (const launch of launches.slice(1))
      workerContexts.set(
        launch.diagnosticContext!.taskId,
        await readFile(launch.contextPath, "utf8"),
      );
    expect(workerContexts.get("alpha")).toContain('"id": "alpha"');
    expect(workerContexts.get("alpha")).not.toContain('"id": "beta"');
    expect(workerContexts.get("beta")).toContain('"id": "beta"');
  });

  it("joins an empty collection without launching a worker", async () => {
    const root = await project(validWorkflow);
    let launches = 0;
    const executor: TaskExecutor = {
      async execute(launch, onStarted) {
        launches += 1;
        await onStarted({ executionId: "producer" });
        await writeFile(
          launch.resultPath,
          JSON.stringify({
            outcome: "completed",
            outputs: { tasks: [] },
            documents: [],
          }),
        );
        return {
          references: { executionId: "producer" },
          logs: { stdout: "", stderr: "" },
        };
      },
      async cancel() {},
      reconcile() {
        return Promise.resolve("stopped");
      },
    };
    const run = await new ExecuteWorkflow(
      new FilesystemProjectDefinitions(),
      new FilesystemRunRepository(),
      executor,
      () => new Date("2026-08-26T12:00:00.000Z"),
      () => "empty-test",
      wait,
    ).execute({
      workflowPath: "workflows/flow.yaml",
      currentDirectory: root,
      onRunAllocated() {},
    });
    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
    expect(launches).toBe(1);
  });
});
