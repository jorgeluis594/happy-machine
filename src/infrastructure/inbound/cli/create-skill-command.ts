import type {
  CreateSkillRequest,
  CreateSkillResult,
} from "../../../application/use-cases/create-skill/create-skill.js";
import { isCreateSkillError } from "../../../application/use-cases/create-skill/create-skill-errors.js";
import { CreateSkillPresenter } from "./create-skill-presenter.js";

export interface CreateSkillUseCase {
  execute(request: CreateSkillRequest): Promise<CreateSkillResult>;
}

export interface CreateSkillTerminal {
  isStdinInteractive(): boolean;
  isStdoutInteractive(): boolean;
  question(prompt: string): Promise<string>;
}

export interface CreateSkillStreams {
  stdout(message: string): void;
  stderr(message: string): void;
}

export class CreateSkillCommand {
  constructor(
    private readonly useCase: CreateSkillUseCase,
    private readonly terminal: CreateSkillTerminal,
    private readonly streams: CreateSkillStreams,
    private readonly presenter = new CreateSkillPresenter(),
  ) {}

  async run(
    args: readonly string[],
    currentDirectory: string,
    signal?: AbortSignal,
  ): Promise<number> {
    if (args.length !== 1 || args[0] !== "--agent=codex") {
      this.streams.stderr(this.presenter.invalidArguments());
      return 1;
    }
    if (
      !this.terminal.isStdinInteractive() ||
      !this.terminal.isStdoutInteractive()
    ) {
      this.streams.stderr(this.presenter.nonInteractiveTerminal());
      return 1;
    }

    let workflowDescription: string;
    try {
      workflowDescription = (
        await this.terminal.question(this.presenter.workflowDescriptionPrompt())
      ).trim();
    } catch {
      this.streams.stderr(this.presenter.workflowDescriptionRequired());
      return 1;
    }
    if (workflowDescription.length === 0) {
      this.streams.stderr(this.presenter.workflowDescriptionRequired());
      return 1;
    }

    try {
      const result = await this.useCase.execute({
        workflowDescription,
        currentDirectory,
        confirmRecording: async () =>
          (
            await this.terminal.question(
              this.presenter.recordingConsentPrompt(),
            )
          )
            .trim()
            .toLowerCase() === "y",
        signal,
      });
      this.streams.stdout(this.presenter.result(result));
      return result.outcome === "completed" || result.stage === "consent"
        ? 0
        : 2;
    } catch (error) {
      if (isCreateSkillError(error)) {
        this.streams.stderr(this.presenter.failure(error));
      } else {
        this.streams.stderr(
          "Create-skill failed unexpectedly. Cleanup status is unknown. Start a new run to try again.",
        );
      }
      return 1;
    }
  }
}
