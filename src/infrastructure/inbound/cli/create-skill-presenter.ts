import type {
  CreateSkillError,
  CreateSkillErrorCode,
} from "../../../application/use-cases/create-skill/create-skill-errors.js";
import type { CreateSkillResult } from "../../../application/use-cases/create-skill/create-skill.js";

const failureMessages: Record<CreateSkillErrorCode, string> = {
  capture_already_active: "Another create-skill recording is already active.",
  agent_runtime_unavailable:
    "Codex is unavailable. Install or configure a compatible Codex CLI.",
  agent_runtime_incompatible:
    "The installed Codex CLI is not compatible with create-skill.",
  demonstration_failed: "The workflow demonstration could not be captured.",
  demonstration_empty: "The workflow demonstration contained no conversation.",
  analysis_failed: "The workflow demonstration could not be analyzed.",
  invalid_analysis: "Codex returned invalid workflow context.",
  generation_start_failed: "The skill-creation session could not be started.",
  cleanup_failed: "Temporary create-skill data could not be fully removed.",
};

export class CreateSkillPresenter {
  workflowDescriptionPrompt(): string {
    return "What workflow are you going to perform? ";
  }

  recordingConsentPrompt(): string {
    return [
      "Recording notice:",
      "- The complete Codex conversation will be captured and used to create a skill.",
      "- Keep the Codex session dedicated to the workflow you described.",
      "- You may decline now before recording begins.",
      "Start recording? [y/N] ",
    ].join("\n");
  }

  invalidArguments(): string {
    return [
      "Invalid arguments for command: create-skill",
      "Usage: happy-machine create-skill --agent=codex",
    ].join("\n");
  }

  nonInteractiveTerminal(): string {
    return "create-skill requires interactive stdin and stdout terminals.";
  }

  workflowDescriptionRequired(): string {
    return "A non-empty workflow description is required.";
  }

  result(result: CreateSkillResult): string {
    if (result.outcome === "completed") {
      return "Skill creation finished. Temporary data cleanup completed.";
    }
    if (result.stage === "consent") {
      return "Recording declined. No workflow was captured.";
    }
    return [
      `Create-skill was canceled during ${result.stage}.`,
      "Temporary data cleanup completed. Start a new run to try again.",
    ].join("\n");
  }

  failure(error: CreateSkillError): string {
    const cleanupIncomplete = error.cleanupFailures.length > 0;
    return [
      `Create-skill failed [${error.code}] during ${error.stage}.`,
      failureMessages[error.code],
      cleanupIncomplete
        ? "Temporary data cleanup is incomplete."
        : "Temporary data cleanup completed.",
      ...(cleanupIncomplete
        ? error.remainingWorkspaces.map(
            (workspace) =>
              `Private workspace requiring manual removal: ${workspace}`,
          )
        : []),
      "Start a new run to try again.",
    ].join("\n");
  }
}
