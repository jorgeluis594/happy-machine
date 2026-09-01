import type { JsonValue } from "../domain/execution/run.js";

export interface EffectivePolicies {
  attemptTimeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  workflowTimeoutMs: number;
  maxStateVisits: number;
  maxTransitions: number;
  maxConcurrency: number;
  controllerLeaseMs: number;
}

export type AgentRuntime = "codex" | "opencode";

export interface AgentDefinition {
  id: string;
  instructions: string;
  runtime: AgentRuntime;
  model?: string;
  reasoning?: string;
}

export type DefinitionArtifactKind =
  | "project_configuration"
  | "workflow"
  | "agent_instructions"
  | "inline_prompt"
  | "prompt_file";

export interface DefinitionArtifactSource {
  kind: DefinitionArtifactKind;
  logicalId: string;
  content: string;
}

export interface InputDocumentSource {
  id: string;
  originalName: string;
  content: string;
}

export interface AgentWorkDefinition {
  type?: "agent";
  agent: AgentDefinition;
  prompt: string;
  policies: EffectivePolicies;
}

/** A binding that can be resolved before a parallel task is launched. */
// `$item` is a reserved binding even though it is also a valid JSON string.
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export type JsonBindingDefinition = JsonValue | "$item";

export interface WorkflowWorkDefinition {
  type: "workflow";
  workflowId: string;
  with: Record<string, JsonBindingDefinition>;
  workflow: EffectiveExecutionDefinition;
  evaluator: {
    id: string;
    runtime: AgentRuntime;
    model?: string;
    reasoning?: string;
    prompt: string;
    policy: {
      attemptTimeoutMs: number;
      maxAttempts: number;
      retryDelayMs: number;
    };
  };
}

export type ParallelTaskWorkDefinition =
  { type: "agent"; work: AgentWorkDefinition } | WorkflowWorkDefinition;

export interface WorkItemsOutputDefinition {
  type: "work_items";
  maxItems: number;
}

export type StructuredOutputDefinition = WorkItemsOutputDefinition;

export interface NormalStateDefinition extends AgentWorkDefinition {
  id: string;
  type: "agent";
  outcomes: Record<string, string>;
  produces?: Record<string, StructuredOutputDefinition>;
  /** Task 01 compatibility until the multi-state executor is delivered. */
  attemptTimeoutMs: number;
}

export interface AgentParallelTaskDefinition extends AgentWorkDefinition {
  id: string;
  type?: "agent";
}

export interface WorkflowParallelTaskDefinition extends WorkflowWorkDefinition {
  id: string;
  /** Compatibility-shaped optional fields keep legacy consumers type-safe. */
  agent: AgentDefinition;
  prompt?: string;
  policies: EffectivePolicies;
}

export type ParallelTaskDefinition =
  AgentParallelTaskDefinition | WorkflowParallelTaskDefinition;

interface ParallelStateDefinitionBase {
  id: string;
  type: "parallel";
  outcomes: { succeeded: string; failed: string };
  policies: EffectivePolicies;
  effectiveMaxConcurrency: number;
}

export interface StaticParallelStateDefinition extends ParallelStateDefinitionBase {
  mode?: "static";
  tasks: Record<string, ParallelTaskDefinition>;
}

export interface DynamicSourceDefinition {
  stateId: string;
  outputName: string;
}

export interface DynamicParallelStateDefinition extends ParallelStateDefinitionBase {
  mode: "dynamic";
  tasks: Record<string, never>;
  forEach: DynamicSourceDefinition;
  task: AgentWorkDefinition | WorkflowWorkDefinition;
}

export type ParallelStateDefinition =
  StaticParallelStateDefinition | DynamicParallelStateDefinition;

export type StateDefinition = NormalStateDefinition | ParallelStateDefinition;

export interface EffectiveExecutionDefinition {
  workflowId: string;
  executorType: "orca";
  workspaceMode: "direct" | "worktree";
  agents: Record<string, AgentDefinition>;
  policies: EffectivePolicies;
  states: Record<string, StateDefinition>;
  initialState: string;
}

export interface DefinitionSnapshotSource {
  effectiveDefinition: EffectiveExecutionDefinition;
  artifacts: DefinitionArtifactSource[];
  inputs: InputDocumentSource[];
}

export interface ExecutionDefinition extends EffectiveExecutionDefinition {
  projectRoot: string;
  workflowPath: string;
  snapshotSource: DefinitionSnapshotSource;
  /** Task 01 compatibility until the multi-state executor is delivered. */
  state: StateDefinition;
}

export interface ProjectDefinitions {
  load(
    workflowPath: string,
    currentDirectory: string,
    inputPaths?: readonly string[],
  ): Promise<ExecutionDefinition>;
}
