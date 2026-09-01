import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import type {
  AgentDefinition,
  AgentRuntime,
  DefinitionArtifactSource,
  EffectivePolicies,
  EffectiveExecutionDefinition,
  ExecutionDefinition,
  InputDocumentSource,
  ParallelStateDefinition,
  ParallelTaskDefinition,
  ProjectDefinitions,
  StateDefinition,
} from "../../../../ports/project-definitions.js";

type Mapping = Record<string, unknown>;
type PolicyName = keyof EffectivePolicies;

const executeFile = promisify(execFile);
const terminals = new Set(["$succeeded", "$failed"]);
const policyFields = {
  attempt_timeout: "attemptTimeoutMs",
  max_attempts: "maxAttempts",
  retry_delay: "retryDelayMs",
  workflow_timeout: "workflowTimeoutMs",
  max_state_visits: "maxStateVisits",
  max_transitions: "maxTransitions",
  max_concurrency: "maxConcurrency",
  controller_lease: "controllerLeaseMs",
} as const satisfies Record<string, PolicyName>;
type PolicyField = keyof typeof policyFields;

const defaults: EffectivePolicies = {
  attemptTimeoutMs: 30 * 60_000,
  maxAttempts: 3,
  retryDelayMs: 5_000,
  workflowTimeoutMs: 24 * 3_600_000,
  maxStateVisits: 10,
  maxTransitions: 100,
  maxConcurrency: 4,
  controllerLeaseMs: 30_000,
};

const scopes: Record<"project" | "workflow" | "state" | "task", PolicyField[]> =
  {
    project: Object.keys(policyFields) as PolicyField[],
    workflow: [
      "attempt_timeout",
      "max_attempts",
      "retry_delay",
      "workflow_timeout",
      "max_state_visits",
      "max_transitions",
      "max_concurrency",
    ],
    state: [
      "attempt_timeout",
      "max_attempts",
      "retry_delay",
      "max_concurrency",
    ],
    task: ["attempt_timeout", "max_attempts", "retry_delay"],
  };

export class DefinitionError extends Error {}

export class FilesystemProjectDefinitions implements ProjectDefinitions {
  async load(
    workflowPathInput: string,
    currentDirectory: string,
    inputPaths: readonly string[] = [],
  ): Promise<ExecutionDefinition> {
    const absoluteWorkflow = path.resolve(currentDirectory, workflowPathInput);
    const discoveredRoot = await this.discover(path.dirname(absoluteWorkflow));
    if (!discoveredRoot)
      throw new DefinitionError(
        "No happy-machine.yaml found in the workflow path ancestor chain",
      );
    const root = discoveredRoot;
    const configPath = await this.safeExistingFile(
      root,
      path.join(root, "happy-machine.yaml"),
      "project configuration",
      ".yaml",
    );
    const configContent = await this.text(configPath, "project configuration");
    const config = this.yaml(configPath, configContent);
    const workflowPath = await this.safeExistingFile(
      root,
      absoluteWorkflow,
      "workflow",
      ".yaml",
    );
    const workflowContent = await this.text(workflowPath, "workflow");
    const workflow = this.yaml(workflowPath, workflowContent);
    const artifacts: DefinitionArtifactSource[] = [
      {
        kind: "project_configuration",
        logicalId: "project",
        content: configContent,
      },
      {
        kind: "workflow",
        logicalId: "workflow",
        content: workflowContent,
      },
    ];

    this.keys(
      config,
      ["version", "executor", "workspace", "agents", "defaults"],
      "project",
    );
    this.keys(
      workflow,
      ["version", "id", "initial_state", "states", "policies"],
      "workflow",
    );
    this.version(config.version, "project.version");
    this.version(workflow.version, "workflow.version");

    const executor = this.optionalMap(config.executor, "project.executor");
    this.keys(executor, ["type"], "project.executor");
    this.equal(
      executor.type ?? "orca",
      "orca",
      "project.executor.type must be orca",
    );
    const workspace = this.optionalMap(config.workspace, "project.workspace");
    this.keys(workspace, ["mode"], "project.workspace");
    const workspaceMode = workspace.mode ?? "direct";
    if (workspaceMode !== "direct" && workspaceMode !== "worktree")
      throw new DefinitionError(
        "project.workspace.mode must be direct or worktree",
      );
    if (workspaceMode === "worktree") await this.requireWorktreeSupport(root);

    const agents = await this.agents(root, config.agents, artifacts);
    const projectPolicies = this.policies(
      defaults,
      config.defaults,
      "project",
      "project.defaults",
    );
    const workflowPolicies = this.policies(
      projectPolicies,
      workflow.policies,
      "workflow",
      "workflow.policies",
    );
    const workflowId = this.string(workflow.id, "workflow.id");
    const initialState = this.string(
      workflow.initial_state,
      "workflow.initial_state",
    );
    const rawStates = this.map(workflow.states, "workflow.states");
    if (Object.keys(rawStates).length === 0)
      throw new DefinitionError("workflow.states must not be empty");
    if (!(initialState in rawStates))
      throw new DefinitionError(
        `workflow.initial_state references unknown state: ${initialState}`,
      );

    const states: Record<string, StateDefinition> = {};
    for (const [id, value] of Object.entries(rawStates)) {
      this.id(id, `state ID ${id}`);
      states[id] = await this.state(
        root,
        id,
        value,
        agents,
        workflowPolicies,
        artifacts,
      );
    }
    this.graph(initialState, states);

    const initial = states[initialState];
    const effectiveDefinition: EffectiveExecutionDefinition = {
      workflowId,
      executorType: "orca",
      workspaceMode,
      agents,
      policies: workflowPolicies,
      states,
      initialState,
    };
    const inputs = await this.inputs(inputPaths, currentDirectory);
    return {
      projectRoot: root,
      workflowPath,
      ...effectiveDefinition,
      snapshotSource: { effectiveDefinition, artifacts, inputs },
      state: initial,
    };
  }

  private async agents(
    root: string,
    value: unknown,
    artifacts: DefinitionArtifactSource[],
  ): Promise<Record<string, AgentDefinition>> {
    const rawAgents = this.map(value, "project.agents");
    if (Object.keys(rawAgents).length === 0)
      throw new DefinitionError("project.agents must not be empty");
    const result: Record<string, AgentDefinition> = {};
    for (const [id, value] of Object.entries(rawAgents)) {
      this.id(id, `agent ID ${id}`);
      const raw = this.map(value, `project.agents.${id}`);
      this.keys(
        raw,
        ["instructions", "runtime", "model", "reasoning"],
        `project.agents.${id}`,
      );
      const instructions = await this.markdown(
        root,
        raw.instructions,
        `project.agents.${id}.instructions`,
      );
      artifacts.push({
        kind: "agent_instructions",
        logicalId: id,
        content: instructions,
      });
      const runtime = this.runtime(raw.runtime, `project.agents.${id}.runtime`);
      if (raw.model !== undefined && runtime !== "codex")
        throw new DefinitionError(
          `project.agents.${id}.model requires runtime codex`,
        );
      result[id] = {
        id,
        instructions,
        runtime,
        ...(raw.model === undefined
          ? {}
          : { model: this.string(raw.model, `project.agents.${id}.model`) }),
        ...(raw.reasoning === undefined
          ? {}
          : {
              reasoning: this.string(
                raw.reasoning,
                `project.agents.${id}.reasoning`,
              ),
            }),
      };
    }
    return result;
  }

  private async state(
    root: string,
    id: string,
    value: unknown,
    agents: Record<string, AgentDefinition>,
    inherited: EffectivePolicies,
    artifacts: DefinitionArtifactSource[],
  ): Promise<StateDefinition> {
    const raw = this.map(value, `workflow.states.${id}`);
    const type = this.string(raw.type, `workflow.states.${id}.type`);
    if (type === "agent") {
      this.keys(
        raw,
        [
          "type",
          "agent",
          "prompt",
          "prompt_file",
          "outcomes",
          "attempt_timeout",
          "max_attempts",
          "retry_delay",
          "produces",
        ],
        `workflow.states.${id}`,
      );
      const policies = this.inlinePolicies(
        inherited,
        raw,
        "state",
        `workflow.states.${id}`,
      );
      const work = await this.work(
        root,
        raw,
        agents,
        policies,
        `workflow.states.${id}`,
        artifacts,
      );
      const outcomes = this.outcomes(
        raw.outcomes,
        `workflow.states.${id}.outcomes`,
      );
      if (Object.keys(outcomes).length === 0)
        throw new DefinitionError(
          `workflow.states.${id}.outcomes must not be empty`,
        );
      return {
        id,
        type: "agent",
        ...work,
        outcomes,
        ...(raw.produces === undefined
          ? {}
          : {
              produces: this.produces(
                raw.produces,
                `workflow.states.${id}.produces`,
              ),
            }),
        policies,
        attemptTimeoutMs: policies.attemptTimeoutMs,
      };
    }
    if (type === "parallel") {
      this.keys(
        raw,
        [
          "type",
          "tasks",
          "for_each",
          "task",
          "outcomes",
          "attempt_timeout",
          "max_attempts",
          "retry_delay",
          "max_concurrency",
        ],
        `workflow.states.${id}`,
      );
      const policies = this.inlinePolicies(
        inherited,
        raw,
        "state",
        `workflow.states.${id}`,
      );
      const hasStatic = raw.tasks !== undefined;
      const hasDynamic = raw.for_each !== undefined || raw.task !== undefined;
      if (hasStatic === hasDynamic)
        throw new DefinitionError(
          `workflow.states.${id} must declare exactly one of tasks or for_each plus task`,
        );
      const rawTasks = hasStatic
        ? this.map(raw.tasks, `workflow.states.${id}.tasks`)
        : {};
      if (hasStatic && Object.keys(rawTasks).length === 0)
        throw new DefinitionError(
          `workflow.states.${id}.tasks must contain at least one task`,
        );
      const tasks: Record<string, ParallelTaskDefinition> = {};
      for (const [taskId, taskValue] of Object.entries(rawTasks)) {
        this.id(taskId, `task ID ${taskId}`);
        const task = this.map(
          taskValue,
          `workflow.states.${id}.tasks.${taskId}`,
        );
        this.keys(
          task,
          [
            "agent",
            "prompt",
            "prompt_file",
            "attempt_timeout",
            "max_attempts",
            "retry_delay",
          ],
          `workflow.states.${id}.tasks.${taskId}`,
        );
        const taskPolicies = this.inlinePolicies(
          policies,
          task,
          "task",
          `workflow.states.${id}.tasks.${taskId}`,
        );
        tasks[taskId] = {
          id: taskId,
          ...(await this.work(
            root,
            task,
            agents,
            taskPolicies,
            `workflow.states.${id}.tasks.${taskId}`,
            artifacts,
          )),
          policies: taskPolicies,
        };
      }
      const outcomes = this.outcomes(
        raw.outcomes,
        `workflow.states.${id}.outcomes`,
      );
      const names = Object.keys(outcomes).sort();
      if (names.join(",") !== "failed,succeeded")
        throw new DefinitionError(
          `workflow.states.${id}.outcomes must contain exactly succeeded and failed`,
        );
      if (hasDynamic) {
        const forEach = this.map(
          raw.for_each,
          `workflow.states.${id}.for_each`,
        );
        this.keys(forEach, ["from"], `workflow.states.${id}.for_each`);
        const source = this.source(
          this.string(forEach.from, `workflow.states.${id}.for_each.from`),
          `workflow.states.${id}.for_each.from`,
        );
        const task = this.map(raw.task, `workflow.states.${id}.task`);
        this.keys(
          task,
          [
            "agent",
            "prompt",
            "prompt_file",
            "attempt_timeout",
            "max_attempts",
            "retry_delay",
          ],
          `workflow.states.${id}.task`,
        );
        const taskPolicies = this.inlinePolicies(
          policies,
          task,
          "task",
          `workflow.states.${id}.task`,
        );
        return {
          id,
          type: "parallel",
          mode: "dynamic",
          tasks: {},
          forEach: source,
          task: {
            ...(await this.work(
              root,
              task,
              agents,
              taskPolicies,
              `workflow.states.${id}.task`,
              artifacts,
            )),
            policies: taskPolicies,
          },
          outcomes: { succeeded: outcomes.succeeded, failed: outcomes.failed },
          policies,
          effectiveMaxConcurrency: policies.maxConcurrency,
        } satisfies ParallelStateDefinition;
      }
      return {
        id,
        type,
        mode: "static",
        tasks,
        outcomes: { succeeded: outcomes.succeeded, failed: outcomes.failed },
        policies,
        effectiveMaxConcurrency: Math.min(
          policies.maxConcurrency,
          Object.keys(tasks).length,
        ),
      } satisfies ParallelStateDefinition;
    }
    throw new DefinitionError(
      `workflow.states.${id}.type must be agent or parallel`,
    );
  }

  private produces(value: unknown, label: string) {
    const raw = this.map(value, label);
    if (Object.keys(raw).length === 0)
      throw new DefinitionError(`${label} must not be empty`);
    const result: Record<string, { type: "work_items"; maxItems: number }> = {};
    for (const [name, definition] of Object.entries(raw)) {
      this.id(name, `output name ${name} at ${label}`);
      const item = this.map(definition, `${label}.${name}`);
      this.keys(item, ["type", "max_items"], `${label}.${name}`);
      if (item.type !== "work_items")
        throw new DefinitionError(`${label}.${name}.type must be work_items`);
      result[name] = {
        type: "work_items",
        maxItems:
          item.max_items === undefined
            ? 100
            : this.positiveInteger(
                item.max_items,
                `${label}.${name}.max_items`,
              ),
      };
    }
    return result;
  }

  private source(value: string, label: string) {
    const match = /^([^.$]+)\.outputs\.([^.$]+)$/.exec(value);
    if (!match)
      throw new DefinitionError(
        `${label} must match <state-id>.outputs.<output-name>`,
      );
    return { stateId: match[1], outputName: match[2] };
  }

  private async work(
    root: string,
    raw: Mapping,
    agents: Record<string, AgentDefinition>,
    policies: EffectivePolicies,
    label: string,
    artifacts: DefinitionArtifactSource[],
  ) {
    const agentId = this.string(raw.agent, `${label}.agent`);
    const registered = agents[agentId];
    if (!registered)
      throw new DefinitionError(
        `${label}.agent references unknown agent: ${agentId}`,
      );
    const hasPrompt = Object.hasOwn(raw, "prompt");
    const hasPromptFile = Object.hasOwn(raw, "prompt_file");
    if (hasPrompt === hasPromptFile)
      throw new DefinitionError(
        `${label} must declare exactly one of prompt or prompt_file`,
      );
    const prompt = hasPrompt
      ? this.string(raw.prompt, `${label}.prompt`)
      : await this.markdown(root, raw.prompt_file, `${label}.prompt_file`);
    artifacts.push({
      kind: hasPrompt ? "inline_prompt" : "prompt_file",
      logicalId: label,
      content: prompt,
    });
    return { agent: registered, prompt, policies };
  }

  private outcomes(value: unknown, label: string): Record<string, string> {
    const raw = this.map(value, label);
    const result: Record<string, string> = {};
    for (const [name, target] of Object.entries(raw)) {
      this.id(name, `outcome name ${name} at ${label}`);
      result[name] = this.string(target, `${label}.${name}`);
    }
    return result;
  }

  private graph(
    initial: string,
    states: Record<string, StateDefinition>,
  ): void {
    for (const state of Object.values(states)) {
      if (state.type !== "parallel" || state.mode !== "dynamic") continue;
      const producer = states[state.forEach.stateId];
      if (!producer || producer.type !== "agent")
        throw new DefinitionError(
          `workflow.states.${state.id}.for_each references unknown producer: ${state.forEach.stateId}`,
        );
      if (!producer.produces?.[state.forEach.outputName])
        throw new DefinitionError(
          `workflow.states.${state.id}.for_each references unknown work_items output: ${state.forEach.outputName}`,
        );
    }
    for (const state of Object.values(states)) {
      for (const [outcome, target] of Object.entries(state.outcomes)) {
        if (!terminals.has(target) && !(target in states))
          throw new DefinitionError(
            `workflow.states.${state.id}.outcomes.${outcome} references unknown target: ${target}`,
          );
      }
    }
    const reachable = this.walk([initial], states, false);
    const unreachable = Object.keys(states).filter((id) => !reachable.has(id));
    if (unreachable.length)
      throw new DefinitionError(
        `workflow state is unreachable from initial_state: ${unreachable[0]}`,
      );
    const canTerminate = this.walk(["$succeeded", "$failed"], states, true);
    const trapped = [...reachable].find((id) => !canTerminate.has(id));
    if (trapped)
      throw new DefinitionError(
        `reachable workflow state cannot reach a terminal target: ${trapped}`,
      );
  }

  private walk(
    starts: string[],
    states: Record<string, StateDefinition>,
    reverse: boolean,
  ): Set<string> {
    const seen = new Set(starts);
    const queue = [...starts];
    while (queue.length) {
      const current = queue.shift()!;
      if (!reverse) {
        const state = states[current];
        if (!state) continue;
        for (const target of Object.values(state.outcomes))
          if (!seen.has(target)) {
            seen.add(target);
            queue.push(target);
          }
      } else {
        for (const state of Object.values(states))
          if (
            !seen.has(state.id) &&
            Object.values(state.outcomes).includes(current)
          ) {
            seen.add(state.id);
            queue.push(state.id);
          }
      }
    }
    return seen;
  }

  private policies(
    base: EffectivePolicies,
    value: unknown,
    scope: keyof typeof scopes,
    label: string,
  ): EffectivePolicies {
    const raw = this.optionalMap(value, label);
    this.keys(raw, scopes[scope], label);
    return this.applyPolicies(base, raw, label);
  }

  private inlinePolicies(
    base: EffectivePolicies,
    raw: Mapping,
    scope: "state" | "task",
    label: string,
  ): EffectivePolicies {
    const selected: Mapping = {};
    for (const field of Object.keys(policyFields) as PolicyField[])
      if (Object.hasOwn(raw, field)) selected[field] = raw[field];
    this.keys(selected, scopes[scope], `${label} policies`);
    return this.applyPolicies(base, selected, label);
  }

  private applyPolicies(
    base: EffectivePolicies,
    raw: Mapping,
    label: string,
  ): EffectivePolicies {
    const result = { ...base };
    for (const [field, value] of Object.entries(raw) as [
      PolicyField,
      unknown,
    ][]) {
      const property = policyFields[field];
      result[property] =
        field.endsWith("timeout") ||
        field.endsWith("delay") ||
        field === "controller_lease"
          ? this.duration(value, `${label}.${field}`)
          : this.positiveInteger(value, `${label}.${field}`);
    }
    return result;
  }

  private async discover(start: string): Promise<string | undefined> {
    let directory = path.resolve(start);
    while (true) {
      try {
        if ((await stat(path.join(directory, "happy-machine.yaml"))).isFile())
          return directory;
      } catch {
        /* search parent */
      }
      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }

  private yaml(file: string, content: string): Mapping {
    try {
      return this.map(parse(content, { uniqueKeys: true }), file);
    } catch (error) {
      throw new DefinitionError(
        `Cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async text(file: string, label: string): Promise<string> {
    try {
      return await readFile(file, "utf8");
    } catch {
      throw new DefinitionError(`Cannot read ${label}: ${file}`);
    }
  }

  private async inputs(
    inputPaths: readonly string[],
    currentDirectory: string,
  ): Promise<InputDocumentSource[]> {
    const inputs: InputDocumentSource[] = [];
    for (const [index, inputPath] of inputPaths.entries()) {
      const candidate = path.resolve(currentDirectory, inputPath);
      let canonical: string;
      try {
        canonical = await realpath(candidate);
      } catch {
        throw new DefinitionError(`input file does not exist: ${candidate}`);
      }
      if (path.extname(candidate).toLowerCase() !== ".md")
        throw new DefinitionError(`input must be a .md file: ${candidate}`);
      try {
        if (!(await stat(canonical)).isFile()) throw new Error();
      } catch {
        throw new DefinitionError(`input must be a file: ${candidate}`);
      }
      let content: string;
      try {
        content = await readFile(canonical, "utf8");
      } catch {
        throw new DefinitionError(`Cannot read input: ${candidate}`);
      }
      inputs.push({
        id: `input-${String(index + 1).padStart(4, "0")}`,
        originalName: path.basename(candidate),
        content,
      });
    }
    return inputs;
  }

  private async markdown(
    root: string,
    value: unknown,
    label: string,
  ): Promise<string> {
    const file = await this.safeExistingFile(
      root,
      path.resolve(root, this.string(value, label)),
      label,
      ".md",
    );
    return this.text(file, label);
  }

  private async safeExistingFile(
    root: string,
    candidate: string,
    label: string,
    extension: string,
  ): Promise<string> {
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      throw new DefinitionError(`${label} file does not exist: ${candidate}`);
    }
    const canonicalRoot = await realpath(root);
    const relative = path.relative(canonicalRoot, canonical);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new DefinitionError(`${label} path escapes the project root`);
    if (path.extname(canonical).toLowerCase() !== extension)
      throw new DefinitionError(`${label} must be a ${extension} file`);
    try {
      if (!(await stat(canonical)).isFile()) throw new Error();
    } catch {
      throw new DefinitionError(`${label} must be a file: ${canonical}`);
    }
    return path.resolve(candidate);
  }

  private async requireWorktreeSupport(root: string): Promise<void> {
    try {
      const { stdout } = await executeFile("git", [
        "-C",
        root,
        "rev-parse",
        "--is-inside-work-tree",
      ]);
      if (stdout.trim() !== "true") throw new Error();
      await executeFile("git", ["-C", root, "rev-parse", "--verify", "HEAD"]);
    } catch {
      throw new DefinitionError(
        "project.workspace.mode worktree requires a Git worktree-capable project",
      );
    }
  }

  private map(value: unknown, label: string): Mapping {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new DefinitionError(`${label} must be a mapping`);
    return value as Mapping;
  }
  private optionalMap(value: unknown, label: string): Mapping {
    return value === undefined ? {} : this.map(value, label);
  }
  private string(value: unknown, label: string): string {
    if (typeof value !== "string" || value.trim() === "")
      throw new DefinitionError(`${label} must be a non-empty string`);
    return value;
  }

  private runtime(value: unknown, label: string): AgentRuntime {
    if (value === undefined) return "codex";
    if (value !== "codex" && value !== "opencode")
      throw new DefinitionError(`${label} must be codex or opencode`);
    return value;
  }
  private id(value: string, label: string): void {
    if (value.trim() === "" || value.startsWith("$"))
      throw new DefinitionError(`${label} is invalid`);
  }
  private version(value: unknown, label: string): void {
    this.equal(value, 1, `${label} must be 1`);
  }
  private equal(actual: unknown, expected: unknown, message: string): void {
    if (actual !== expected) throw new DefinitionError(message);
  }
  private keys(
    value: Mapping,
    allowed: readonly string[],
    label: string,
  ): void {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown)
      throw new DefinitionError(`Unknown ${label} field: ${unknown}`);
  }
  private positiveInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0)
      throw new DefinitionError(`${label} must be a positive integer`);
    return value as number;
  }
  private duration(value: unknown, label: string): number {
    if (typeof value !== "string")
      throw new DefinitionError(`${label} must be a duration`);
    const match = /^(\d+)(ms|s|m|h)$/.exec(value);
    const amount = match ? Number(match[1]) : 0;
    const milliseconds =
      amount *
      { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match?.[2] ?? "ms"]!;
    if (!match || amount <= 0 || !Number.isSafeInteger(milliseconds))
      throw new DefinitionError(`${label} must be a positive duration`);
    return milliseconds;
  }
}
