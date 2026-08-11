import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import type { ExecutionDefinition, ProjectDefinitions } from '../../../../ports/project-definitions.js';

type Mapping = Record<string, unknown>;

export class DefinitionError extends Error {}

export class FilesystemProjectDefinitions implements ProjectDefinitions {
  async load(workflowPathInput: string, currentDirectory: string): Promise<ExecutionDefinition> {
    const absoluteWorkflow = path.resolve(currentDirectory, workflowPathInput);
    const root = await this.discover(path.dirname(absoluteWorkflow));
    if (!root) throw new DefinitionError('No happy-machine.yaml found in the workflow path ancestor chain');

    const config = await this.yaml(path.join(root, 'happy-machine.yaml'));
    const workflowPath = this.inside(root, absoluteWorkflow, 'workflow');
    const workflow = await this.yaml(workflowPath);
    this.keys(config, ['version', 'executor', 'workspace', 'agents', 'defaults'], 'project');
    this.keys(workflow, ['version', 'id', 'initial_state', 'states', 'policies'], 'workflow');
    this.equal(config.version, 1, 'Project version must be 1');
    this.equal(workflow.version, 1, 'Workflow version must be 1');

    const executor = this.optionalMap(config.executor, 'executor');
    const workspace = this.optionalMap(config.workspace, 'workspace');
    this.keys(executor, ['type'], 'executor');
    this.keys(workspace, ['mode'], 'workspace');
    this.equal(executor.type ?? 'orca', 'orca', 'Only executor.type orca is supported');
    this.equal(workspace.mode ?? 'direct', 'direct', 'Only workspace.mode direct is supported');

    const workflowId = this.string(workflow.id, 'workflow.id');
    const initialState = this.string(workflow.initial_state, 'workflow.initial_state');
    const states = this.map(workflow.states, 'workflow.states');
    if (Object.keys(states).length !== 1) throw new DefinitionError('This release supports exactly one workflow state');
    const rawState = this.map(states[initialState], `states.${initialState}`);
    this.keys(rawState, ['type', 'agent', 'prompt', 'prompt_file', 'outcomes', 'model', 'attempt_timeout'], `states.${initialState}`);
    this.equal(rawState.type, 'agent', 'The workflow state must have type agent');

    const agentId = this.string(rawState.agent, `states.${initialState}.agent`);
    const agents = this.map(config.agents, 'project.agents');
    const rawAgent = this.map(agents[agentId], `agents.${agentId}`);
    this.keys(rawAgent, ['instructions', 'model'], `agents.${agentId}`);
    const instructionsPath = this.inside(root, path.resolve(root, this.string(rawAgent.instructions, `agents.${agentId}.instructions`)), 'instructions');
    if (path.extname(instructionsPath).toLowerCase() !== '.md') throw new DefinitionError('Agent instructions must be a Markdown file');
    const instructions = await this.read(instructionsPath, 'agent instructions');
    const model = this.string(rawState.model ?? rawAgent.model, `agents.${agentId}.model`);

    const hasPrompt = typeof rawState.prompt === 'string';
    const hasPromptFile = typeof rawState.prompt_file === 'string';
    if (hasPrompt === hasPromptFile) throw new DefinitionError(`State ${initialState} must declare exactly one of prompt or prompt_file`);
    const prompt = hasPrompt
      ? this.string(rawState.prompt, `states.${initialState}.prompt`)
      : await this.read(this.inside(root, path.resolve(root, this.string(rawState.prompt_file, `states.${initialState}.prompt_file`)), 'prompt'), 'prompt');

    const rawOutcomes = this.map(rawState.outcomes, `states.${initialState}.outcomes`);
    if (Object.keys(rawOutcomes).length === 0) throw new DefinitionError('The state outcomes map cannot be empty');
    const outcomes: Record<string, '$succeeded' | '$failed'> = {};
    for (const [outcome, target] of Object.entries(rawOutcomes)) {
      if (target !== '$succeeded' && target !== '$failed') throw new DefinitionError(`Outcome ${outcome} must target $succeeded or $failed`);
      outcomes[outcome] = target;
    }
    const defaults = this.optionalMap(config.defaults, 'defaults');
    const timeout = rawState.attempt_timeout ?? defaults.attempt_timeout ?? '30m';

    return {
      projectRoot: root, workflowPath, workflowId, executorType: 'orca', workspaceMode: 'direct',
      state: { id: initialState, agent: { id: agentId, instructions, model }, prompt, outcomes, attemptTimeoutMs: this.duration(timeout) },
    };
  }

  private async discover(start: string): Promise<string | undefined> {
    let directory = path.resolve(start);
    while (true) {
      try { if ((await stat(path.join(directory, 'happy-machine.yaml'))).isFile()) return directory; } catch {}
      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }
  private async yaml(file: string): Promise<Mapping> {
    try { return this.map(parse(await readFile(file, 'utf8'), { uniqueKeys: true }), file); }
    catch (error) { throw new DefinitionError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  private async read(file: string, label: string): Promise<string> {
    try { return await readFile(file, 'utf8'); } catch { throw new DefinitionError(`Cannot read ${label}: ${file}`); }
  }
  private inside(root: string, candidate: string, label: string): string {
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new DefinitionError(`${label} path escapes the project root`);
    return candidate;
  }
  private map(value: unknown, label: string): Mapping {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DefinitionError(`${label} must be a mapping`);
    return value as Mapping;
  }
  private optionalMap(value: unknown, label: string): Mapping { return value === undefined ? {} : this.map(value, label); }
  private string(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim() === '') throw new DefinitionError(`${label} must be a non-empty string`);
    return value;
  }
  private equal(actual: unknown, expected: unknown, message: string): void { if (actual !== expected) throw new DefinitionError(message); }
  private keys(value: Mapping, allowed: string[], label: string): void {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length) throw new DefinitionError(`Unknown ${label} field: ${unknown[0]}`);
  }
  private duration(value: unknown): number {
    if (typeof value !== 'string') throw new DefinitionError('attempt_timeout must be a duration');
    const match = /^(\d+)(ms|s|m|h)$/.exec(value);
    if (!match || Number(match[1]) <= 0) throw new DefinitionError('attempt_timeout must be a positive duration');
    return Number(match[1]) * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2]!]!);
  }
}
