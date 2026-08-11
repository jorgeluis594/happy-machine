import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FilesystemProjectDefinitions } from "../src/infrastructure/outbound/project-definitions/filesystem/filesystem-project-definitions.js";

const loader = new FilesystemProjectDefinitions();

const validProject = `version: 1
agents:
  worker:
    instructions: agents/worker.md
    model: test-model
`;

const validWorkflow = `version: 1
id: validation
initial_state: start
states:
  start:
    type: agent
    agent: worker
    prompt: Do the work.
    outcomes:
      done: $succeeded
`;

async function fixture(project = validProject, workflow = validWorkflow) {
  const root = await mkdtemp(path.join(os.tmpdir(), "definitions-test-"));
  await mkdir(path.join(root, "agents"));
  await mkdir(path.join(root, "workflows"));
  await writeFile(path.join(root, "agents", "worker.md"), "# Worker\n");
  await writeFile(path.join(root, "happy-machine.yaml"), project);
  const workflowPath = path.join(root, "workflows", "workflow.yaml");
  await writeFile(workflowPath, workflow);
  return { root, workflowPath };
}

async function rejection(project: string, workflow: string, message: RegExp) {
  const setup = await fixture(project, workflow);
  await expect(loader.load(setup.workflowPath, setup.root)).rejects.toThrow(
    message,
  );
}

describe("closed definition schema", () => {
  it.each([
    [
      validProject.replace("version: 1", "version: 2"),
      validWorkflow,
      /project\.version/,
    ],
    [
      validProject,
      validWorkflow.replace("version: 1", "version: 2"),
      /workflow\.version/,
    ],
    [
      validProject + "command: echo unsafe\n",
      validWorkflow,
      /Unknown project field: command/,
    ],
    [
      validProject,
      validWorkflow.replace("states:", "on_failure: stop\nstates:"),
      /Unknown workflow field: on_failure/,
    ],
    [
      validProject.replace(
        "    model: test-model",
        "    model: test-model\n    command: pwd",
      ),
      validWorkflow,
      /Unknown project\.agents\.worker field: command/,
    ],
    [
      validProject,
      validWorkflow.replace(
        "    outcomes:",
        "    on_failure: $failed\n    outcomes:",
      ),
      /Unknown workflow\.states\.start field: on_failure/,
    ],
    [
      validProject,
      validWorkflow.replace(
        "    outcomes:",
        "    command: npm test\n    outcomes:",
      ),
      /Unknown workflow\.states\.start field: command/,
    ],
    [
      validProject.replace("version: 1", "version: 1\nversion: 1"),
      validWorkflow,
      /Map keys must be unique/,
    ],
    [
      validProject,
      validWorkflow.replace(
        "      done: $succeeded",
        "      done: $succeeded\n      done: $failed",
      ),
      /Map keys must be unique/,
    ],
    [
      validProject,
      validWorkflow.replace(
        "  start:",
        "  start:\n    type: agent\n    agent: worker\n    prompt: First\n    outcomes: {done: $succeeded}\n  start:",
      ),
      /Map keys must be unique/,
    ],
    [
      validProject,
      `version: 1
id: duplicate-task
initial_state: batch
states:
  batch:
    type: parallel
    tasks:
      same: {agent: worker, prompt: First}
      same: {agent: worker, prompt: Second}
    outcomes: {succeeded: $succeeded, failed: $failed}
`,
      /Map keys must be unique/,
    ],
  ])(
    "rejects invalid closed-schema case %#",
    async (project, workflow, message) => {
      await rejection(project, workflow, message);
    },
  );
});

describe("agents, prompts, states, tasks, and outcomes", () => {
  it.each([
    [
      validProject.replace("    model: test-model", "    model: ''"),
      validWorkflow,
      /model must be a non-empty string/,
    ],
    [
      validProject,
      validWorkflow.replace("agent: worker", "agent: missing"),
      /unknown agent: missing/,
    ],
    [
      validProject,
      validWorkflow.replace(
        "    prompt: Do the work.",
        "    prompt: Do the work.\n    prompt_file: prompts/work.md",
      ),
      /exactly one of prompt or prompt_file/,
    ],
    [
      validProject,
      validWorkflow.replace("    prompt: Do the work.\n", ""),
      /exactly one of prompt or prompt_file/,
    ],
    [
      validProject,
      validWorkflow.replace("      done: $succeeded", "      done: [one, two]"),
      /must be a non-empty string/,
    ],
    [
      validProject,
      validWorkflow.replace(
        "    outcomes:\n      done: $succeeded",
        "    outcomes: {}",
      ),
      /outcomes must not be empty/,
    ],
    [
      validProject,
      validWorkflow.replace("type: agent", "type: shell"),
      /type must be agent or parallel/,
    ],
  ])(
    "rejects invalid registry/work case %#",
    async (project, workflow, message) => {
      await rejection(project, workflow, message);
    },
  );

  it("accepts normal outcomes named succeeded and failed", async () => {
    const setup = await fixture(
      validProject,
      validWorkflow.replace(
        "done: $succeeded",
        "succeeded: $succeeded\n      failed: $failed",
      ),
    );
    const definition = await loader.load(setup.workflowPath, setup.root);
    expect(definition.states.start.outcomes).toEqual({
      succeeded: "$succeeded",
      failed: "$failed",
    });
  });

  it.each([
    [
      "tasks: {}",
      "outcomes:\n      succeeded: $succeeded\n      failed: $failed",
      /at least one task/,
    ],
    [
      "tasks:\n      one:\n        agent: worker\n        prompt: Work",
      "outcomes:\n      succeeded: $succeeded",
      /exactly succeeded and failed/,
    ],
    [
      "tasks:\n      one:\n        agent: worker\n        prompt: Work",
      "outcomes:\n      succeeded: $succeeded\n      failed: $failed\n      skipped: $failed",
      /exactly succeeded and failed/,
    ],
    [
      "tasks:\n      one:\n        agent: missing\n        prompt: Work",
      "outcomes:\n      succeeded: $succeeded\n      failed: $failed",
      /unknown agent/,
    ],
    [
      "tasks:\n      one:\n        agent: worker",
      "outcomes:\n      succeeded: $succeeded\n      failed: $failed",
      /exactly one of prompt or prompt_file/,
    ],
  ])("validates parallel form %#", async (tasks, outcomes, message) => {
    const workflow = `version: 1
id: parallel
initial_state: batch
states:
  batch:
    type: parallel
    ${tasks}
    ${outcomes}
`;
    await rejection(validProject, workflow, message);
  });
});

describe("workflow graph", () => {
  const workflow = (initial: string, states: string) => `version: 1
id: graph
initial_state: ${initial}
states:
${states}
`;
  const state = (id: string, target: string) => `  ${id}:
    type: agent
    agent: worker
    prompt: Work
    outcomes:
      next: ${target}
`;

  it("accepts forward edges", async () => {
    const setup = await fixture(
      validProject,
      workflow(
        "first",
        state("first", "second") + state("second", "$succeeded"),
      ),
    );
    await expect(
      loader.load(setup.workflowPath, setup.root),
    ).resolves.toMatchObject({ initialState: "first" });
  });

  it("accepts cycles and self-loops when a terminal remains reachable", async () => {
    const cycle =
      state("first", "second") +
      `  second:
    type: agent
    agent: worker
    prompt: Work
    outcomes:
      again: first
      done: $succeeded
`;
    const self = `  first:
    type: agent
    agent: worker
    prompt: Work
    outcomes:
      again: first
      done: $failed
`;
    for (const states of [cycle, self]) {
      const setup = await fixture(validProject, workflow("first", states));
      await expect(
        loader.load(setup.workflowPath, setup.root),
      ).resolves.toBeDefined();
    }
  });

  it.each([
    ["missing", state("first", "$succeeded"), /unknown state: missing/],
    ["first", state("first", "missing"), /unknown target: missing/],
    [
      "first",
      state("first", "$succeeded") + state("orphan", "$failed"),
      /unreachable.*orphan/,
    ],
    [
      "first",
      state("first", "second") + state("second", "first"),
      /cannot reach a terminal/,
    ],
  ])("rejects invalid graph %#", async (initial, states, message) => {
    await rejection(validProject, workflow(initial, states), message);
  });
});

describe("effective policies", () => {
  it("applies every normative default", async () => {
    const setup = await fixture();
    const definition = await loader.load(setup.workflowPath, setup.root);
    expect(definition.policies).toEqual({
      attemptTimeoutMs: 1_800_000,
      maxAttempts: 3,
      retryDelayMs: 5_000,
      workflowTimeoutMs: 86_400_000,
      maxStateVisits: 10,
      maxTransitions: 100,
      maxConcurrency: 4,
      controllerLeaseMs: 30_000,
    });
  });

  it("resolves project, workflow, state, and task values from least to most specific", async () => {
    const project =
      validProject +
      `defaults:
  attempt_timeout: 40m
  max_attempts: 4
  retry_delay: 8s
  workflow_timeout: 30h
  max_state_visits: 20
  max_transitions: 200
  max_concurrency: 8
  controller_lease: 45s
`;
    const workflow = `version: 1
id: policies
initial_state: batch
policies:
  attempt_timeout: 20m
  max_attempts: 5
  retry_delay: 7s
  workflow_timeout: 12h
  max_state_visits: 6
  max_transitions: 60
  max_concurrency: 6
states:
  batch:
    type: parallel
    attempt_timeout: 10m
    max_attempts: 6
    retry_delay: 6s
    max_concurrency: 5
    tasks:
      one:
        agent: worker
        prompt: Work
        attempt_timeout: 1m
        max_attempts: 7
        retry_delay: 1s
      two:
        agent: worker
        prompt: Work
    outcomes:
      succeeded: $succeeded
      failed: $failed
`;
    const setup = await fixture(project, workflow);
    const definition = await loader.load(setup.workflowPath, setup.root);
    const batch = definition.states.batch;
    expect(definition.policies).toMatchObject({
      workflowTimeoutMs: 43_200_000,
      maxStateVisits: 6,
      maxTransitions: 60,
      controllerLeaseMs: 45_000,
    });
    expect(batch.type).toBe("parallel");
    if (batch.type !== "parallel") throw new Error("expected parallel");
    expect(batch.policies).toMatchObject({
      attemptTimeoutMs: 600_000,
      maxAttempts: 6,
      retryDelayMs: 6_000,
      maxConcurrency: 5,
    });
    expect(batch.tasks.one.policies).toMatchObject({
      attemptTimeoutMs: 60_000,
      maxAttempts: 7,
      retryDelayMs: 1_000,
    });
    expect(batch.tasks.two.policies).toMatchObject({
      attemptTimeoutMs: 600_000,
      maxAttempts: 6,
      retryDelayMs: 6_000,
    });
    expect(batch.effectiveMaxConcurrency).toBe(2);
  });

  it.each([
    ["defaults:\n  max_attempts: 0", /positive integer/],
    ["defaults:\n  max_attempts: 1.5", /positive integer/],
    ["defaults:\n  attempt_timeout: 0s", /positive duration/],
    ["defaults:\n  retry_delay: nope", /positive duration/],
  ])("rejects invalid policy %#", async (addition, message) => {
    await rejection(validProject + addition + "\n", validWorkflow, message);
  });

  it("rejects a policy at every forbidden scope", async () => {
    await rejection(
      validProject,
      validWorkflow.replace(
        "id: validation",
        "id: validation\npolicies:\n  controller_lease: 5s",
      ),
      /Unknown workflow\.policies field/,
    );
    await rejection(
      validProject,
      validWorkflow.replace(
        "    outcomes:",
        "    workflow_timeout: 1h\n    outcomes:",
      ),
      /Unknown workflow\.states\.start field/,
    );
    const parallel = `version: 1
id: invalid-task-policy
initial_state: batch
states:
  batch:
    type: parallel
    tasks:
      one:
        agent: worker
        prompt: Work
        max_concurrency: 2
    outcomes: {succeeded: $succeeded, failed: $failed}
`;
    await rejection(
      validProject,
      parallel,
      /Unknown workflow\.states\.batch\.tasks\.one field/,
    );
  });
});

describe("definition path safety", () => {
  it("loads in-root Markdown prompt files", async () => {
    const setup = await fixture(
      validProject,
      validWorkflow.replace(
        "prompt: Do the work.",
        "prompt_file: prompts/work.md",
      ),
    );
    await mkdir(path.join(setup.root, "prompts"));
    await writeFile(path.join(setup.root, "prompts", "work.md"), "# Work\n");
    await expect(
      loader.load(setup.workflowPath, setup.root),
    ).resolves.toBeDefined();
  });

  it.each([
    [
      "instructions",
      validProject.replace("agents/worker.md", "../outside.md"),
      validWorkflow,
    ],
    [
      "prompt_file",
      validProject,
      validWorkflow.replace(
        "prompt: Do the work.",
        "prompt_file: ../outside.md",
      ),
    ],
  ])("rejects traversal in %s", async (_label, project, workflow) => {
    const setup = await fixture(project, workflow);
    await writeFile(path.join(setup.root, "..", "outside.md"), "# Outside\n");
    await expect(loader.load(setup.workflowPath, setup.root)).rejects.toThrow(
      /escapes the project root/,
    );
  });

  it("rejects symlink escapes for instructions and prompts", async () => {
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "definitions-outside-"),
    );
    await writeFile(path.join(outside, "outside.md"), "# Outside\n");
    for (const kind of ["instructions", "prompt"] as const) {
      const project =
        kind === "instructions"
          ? validProject.replace("agents/worker.md", "agents/link.md")
          : validProject;
      const workflow =
        kind === "prompt"
          ? validWorkflow.replace(
              "prompt: Do the work.",
              "prompt_file: prompts/link.md",
            )
          : validWorkflow;
      const setup = await fixture(project, workflow);
      const directory = path.join(
        setup.root,
        kind === "prompt" ? "prompts" : "agents",
      );
      await mkdir(directory, { recursive: true });
      await symlink(
        path.join(outside, "outside.md"),
        path.join(directory, "link.md"),
      );
      await expect(loader.load(setup.workflowPath, setup.root)).rejects.toThrow(
        /escapes the project root/,
      );
    }
  });

  it.each([
    [
      validProject.replace("agents/worker.md", "agents/missing.md"),
      validWorkflow,
      /does not exist/,
    ],
    [
      validProject.replace("agents/worker.md", "agents/worker.txt"),
      validWorkflow,
      /must be a \.md file/,
    ],
    [
      validProject,
      validWorkflow.replace(
        "prompt: Do the work.",
        "prompt_file: prompts/missing.md",
      ),
      /does not exist/,
    ],
  ])(
    "rejects missing or non-Markdown files %#",
    async (project, workflow, message) => {
      const setup = await fixture(project, workflow);
      if (project.includes("worker.txt"))
        await writeFile(path.join(setup.root, "agents", "worker.txt"), "text");
      await expect(loader.load(setup.workflowPath, setup.root)).rejects.toThrow(
        message,
      );
    },
  );

  it("rejects worktree mode outside a Git repository", async () => {
    await rejection(
      validProject.replace("agents:", "workspace:\n  mode: worktree\nagents:"),
      validWorkflow,
      /requires a Git/,
    );
  });
});
