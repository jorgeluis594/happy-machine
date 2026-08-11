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
  task: TaskRecord;
  outcome?: string;
  target?: string;
}

export interface RunRecord {
  id: string;
  workflowId: string;
  workflowPath: string;
  projectRoot: string;
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
