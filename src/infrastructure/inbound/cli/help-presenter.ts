interface HelpItem {
  label: string;
  description: string;
}

interface CommandHelp {
  name: string;
  description: string;
  usage: string;
  arguments: readonly HelpItem[];
  options: readonly HelpItem[];
}

const commandHelp = [
  {
    name: "help",
    description: "Show help for Happy Machine commands.",
    usage: "happy-machine help [COMMAND]",
    arguments: [
      {
        label: "COMMAND",
        description: "Command to show help for. Optional.",
      },
    ],
    options: [
      {
        label: "-h, --help",
        description: "Show help for this command.",
      },
    ],
  },
  {
    name: "execute",
    description: "Execute a workflow and remain attached until it finishes.",
    usage:
      "happy-machine execute WORKFLOW_PATH [--input DOCUMENT.md ...] [--debug]",
    arguments: [
      {
        label: "--debug",
        description:
          "Stream structured diagnostics and agent transcripts to stderr.",
      },
      {
        label: "WORKFLOW_PATH",
        description: "Path to the workflow YAML file.",
      },
    ],
    options: [
      {
        label: "--input DOCUMENT.md",
        description: "Add an input document. May be repeated.",
      },
      {
        label: "-h, --help",
        description: "Show help for this command.",
      },
    ],
  },
  {
    name: "resume",
    description: "Resume control of a detached run.",
    usage: "happy-machine resume RUN_ID [--debug]",
    arguments: [
      {
        label: "RUN_ID",
        description: "Run to resume. Required.",
      },
    ],
    options: [
      {
        label: "--debug",
        description:
          "Stream diagnostics and retained agent transcript to stderr.",
      },
      {
        label: "-h, --help",
        description: "Show help for this command.",
      },
    ],
  },
  {
    name: "cancel",
    description: "Cancel a run and reconcile its active work.",
    usage: "happy-machine cancel RUN_ID [--debug]",
    arguments: [
      {
        label: "RUN_ID",
        description: "Run to cancel. Required.",
      },
    ],
    options: [
      {
        label: "--debug",
        description:
          "Stream cancellation diagnostics and agent transcript to stderr.",
      },
      {
        label: "-h, --help",
        description: "Show help for this command.",
      },
    ],
  },
  {
    name: "cleanup",
    description: "Clean up managed worktrees for a run.",
    usage: "happy-machine cleanup RUN_ID",
    arguments: [
      {
        label: "RUN_ID",
        description:
          "Run whose managed worktrees should be cleaned up. Required.",
      },
    ],
    options: [
      {
        label: "-h, --help",
        description: "Show help for this command.",
      },
    ],
  },
  {
    name: "status",
    description: "Show the current status of a run.",
    usage: "happy-machine status RUN_ID",
    arguments: [
      {
        label: "RUN_ID",
        description: "Run to inspect. Required.",
      },
    ],
    options: [
      {
        label: "-h, --help",
        description: "Show help for this command.",
      },
    ],
  },
  {
    name: "history",
    description: "Show project run history or the event history for one run.",
    usage: "happy-machine history [RUN_ID]",
    arguments: [
      {
        label: "RUN_ID",
        description: "Run whose event history should be shown. Optional.",
      },
    ],
    options: [
      {
        label: "-h, --help",
        description: "Show help for this command.",
      },
    ],
  },
] as const satisfies readonly CommandHelp[];

export type HelpCommandName = (typeof commandHelp)[number]["name"];

export class HelpPresenter {
  global(): string {
    const commandWidth = Math.max(
      ...commandHelp.map((command) => command.name.length),
    );
    return [
      "Happy Machine executes durable agent workflows from plain-text project files.",
      "",
      "Usage:",
      "  happy-machine <command> [arguments] [options]",
      "",
      "Commands:",
      ...commandHelp.map(
        (command) =>
          `  ${command.name.padEnd(commandWidth)}  ${command.description}`,
      ),
      "",
      "Run 'happy-machine help <command>' for more information on a command.",
    ].join("\n");
  }

  command(commandName: HelpCommandName): string {
    const command = commandHelp.find(
      (candidate) => candidate.name === commandName,
    );
    if (!command) throw new Error(`Unknown help command: ${commandName}`);
    return [
      command.description,
      "",
      "Usage:",
      `  ${command.usage}`,
      "",
      "Arguments:",
      ...this.items(command.arguments),
      "",
      "Options:",
      ...this.items(command.options),
    ].join("\n");
  }

  isCommand(command: string): command is HelpCommandName {
    return commandHelp.some((candidate) => candidate.name === command);
  }

  private items(items: readonly HelpItem[]): string[] {
    const labelWidth = Math.max(...items.map((item) => item.label.length));
    return items.map(
      (item) => `  ${item.label.padEnd(labelWidth)}  ${item.description}`,
    );
  }
}
