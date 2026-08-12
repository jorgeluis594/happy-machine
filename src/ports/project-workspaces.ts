import type { ManagedWorktreeRecord } from "../domain/execution/run.js";

export interface EnsureMainWorkspaceRequest {
  projectRoot: string;
  runId: string;
}

export interface EnsureChildWorkspaceRequest {
  projectRoot: string;
  runId: string;
  stateId: string;
  visitNumber: number;
  taskId: string;
  startingHead: string;
}

export interface WorktreeObservation {
  endingHead: string;
  dirty: boolean;
}

export interface ProjectWorkspaces {
  ensureMain(
    request: EnsureMainWorkspaceRequest,
  ): Promise<ManagedWorktreeRecord>;
  ensureChild(
    request: EnsureChildWorkspaceRequest,
  ): Promise<ManagedWorktreeRecord>;
  observe(worktree: ManagedWorktreeRecord): Promise<WorktreeObservation>;
}

export class ProjectWorkspaceError extends Error {
  readonly code = "workspace_preparation_failed";

  constructor(message: string) {
    super(message);
  }
}
