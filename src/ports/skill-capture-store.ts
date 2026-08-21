export interface CaptureWorkspace {
  id: string;
}

export interface CaptureArtifact {
  id: string;
  agentReference: string;
}

export interface SkillCaptureStore {
  cleanupAbandoned(): Promise<void>;
  createWorkspace(): Promise<CaptureWorkspace>;
  writeDemonstration(
    workspace: CaptureWorkspace,
    markdown: string,
  ): Promise<CaptureArtifact>;
  writeSkillContext(
    workspace: CaptureWorkspace,
    markdown: string,
  ): Promise<CaptureArtifact>;
  removeArtifact(artifact: CaptureArtifact): Promise<void>;
  cleanup(workspace: CaptureWorkspace): Promise<void>;
}
