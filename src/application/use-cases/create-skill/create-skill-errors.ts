export const createSkillErrorCodes = [
  "capture_already_active",
  "agent_runtime_unavailable",
  "agent_runtime_incompatible",
  "demonstration_failed",
  "demonstration_empty",
  "analysis_failed",
  "invalid_analysis",
  "generation_start_failed",
  "cleanup_failed",
] as const;

export type CreateSkillErrorCode = (typeof createSkillErrorCodes)[number];

export const createSkillStages = [
  "setup",
  "demonstration",
  "analysis",
  "generation",
  "cleanup",
] as const;

export type CreateSkillStage = (typeof createSkillStages)[number];

export interface CreateSkillErrorOptions {
  cause?: unknown;
}

export class CreateSkillError extends Error {
  override readonly name = "CreateSkillError";

  constructor(
    readonly code: CreateSkillErrorCode,
    readonly stage: CreateSkillStage,
    message: string,
    options: CreateSkillErrorOptions = {},
  ) {
    super(message, options);
  }
}

export function isCreateSkillError(error: unknown): error is CreateSkillError {
  return error instanceof CreateSkillError;
}

export function renderCreateSkillError(error: CreateSkillError): string {
  return `${error.name} [${error.code}] at ${error.stage}`;
}
