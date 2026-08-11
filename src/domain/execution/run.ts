export type RunStatus = "running" | "succeeded" | "failed";
export type AttemptStatus = "launching" | "running" | "succeeded" | "failed";

export interface ExecutorReferences {
  runId?: string;
  taskId: string;
  dispatchId: string;
  terminalHandle?: string;
}

export interface AttemptRecord {
  id: string;
  number: number;
  status: AttemptStatus;
  controlWorkspace: string;
  contextPath: string;
  outputDirectory: string;
  resultPath: string;
  executor?: ExecutorReferences;
  logs: { stdout: string; stderr: string };
  outcome?: string;
}

export interface TaskRecord {
  id: string;
  attempts: AttemptRecord[];
}

export interface VisitRecord {
  stateId: string;
  number: number;
  contextPath: string;
  task: TaskRecord;
  outcome?: string;
  target?: string;
}

export interface SnapshotInputRecord {
  id: string;
  originalName: string;
  internalPath: string;
  durablePath: string;
  sha256: string;
}

export interface DefinitionSnapshotRecord {
  identity: string;
  directory: string;
  manifestPath: string;
  inputs: SnapshotInputRecord[];
}

export interface RunRecord {
  id: string;
  workflowId: string;
  workflowPath: string;
  projectRoot: string;
  definitionSnapshot: DefinitionSnapshotRecord;
  status: RunStatus;
  createdAt: string;
  terminalTarget?: "$succeeded" | "$failed";
  visits: VisitRecord[];
  events: Array<{
    sequence: number;
    type: string;
    at: string;
    data: Record<string, unknown>;
  }>;
}

export function terminalStatus(target: string): RunStatus {
  if (target === "$succeeded") return "succeeded";
  if (target === "$failed") return "failed";
  throw new Error(`Unsupported transition target: ${target}`);
}
