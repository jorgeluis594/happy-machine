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

export interface AgentDefinition {
  id: string;
  instructions: string;
  model: string;
}

export interface AgentWorkDefinition {
  agent: AgentDefinition;
  prompt: string;
  policies: EffectivePolicies;
}

export interface NormalStateDefinition extends AgentWorkDefinition {
  id: string;
  type: "agent";
  outcomes: Record<string, string>;
  /** Task 01 compatibility until the multi-state executor is delivered. */
  attemptTimeoutMs: number;
}

export interface ParallelTaskDefinition extends AgentWorkDefinition {
  id: string;
}

export interface ParallelStateDefinition {
  id: string;
  type: "parallel";
  tasks: Record<string, ParallelTaskDefinition>;
  outcomes: { succeeded: string; failed: string };
  policies: EffectivePolicies;
  effectiveMaxConcurrency: number;
}

export type StateDefinition = NormalStateDefinition | ParallelStateDefinition;

export interface ExecutionDefinition {
  projectRoot: string;
  workflowPath: string;
  workflowId: string;
  executorType: "orca";
  workspaceMode: "direct" | "worktree";
  agents: Record<string, AgentDefinition>;
  policies: EffectivePolicies;
  states: Record<string, StateDefinition>;
  initialState: string;
  /** Task 01 compatibility until the multi-state executor is delivered. */
  state: StateDefinition;
}

export interface ProjectDefinitions {
  load(
    workflowPath: string,
    currentDirectory: string,
  ): Promise<ExecutionDefinition>;
}
