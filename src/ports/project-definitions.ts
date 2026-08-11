export interface AgentDefinition {
  id: string;
  instructions: string;
  model: string;
}

export interface NormalStateDefinition {
  id: string;
  agent: AgentDefinition;
  prompt: string;
  outcomes: Record<string, '$succeeded' | '$failed'>;
  attemptTimeoutMs: number;
}

export interface ExecutionDefinition {
  projectRoot: string;
  workflowPath: string;
  workflowId: string;
  executorType: 'orca';
  workspaceMode: 'direct';
  state: NormalStateDefinition;
}

export interface ProjectDefinitions {
  load(workflowPath: string, currentDirectory: string): Promise<ExecutionDefinition>;
}
