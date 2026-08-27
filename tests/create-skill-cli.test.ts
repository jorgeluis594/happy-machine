import { describe, expect, it, vi } from "vitest";
import type {
  CreateSkillRequest,
  CreateSkillResult,
} from "../src/application/use-cases/create-skill/create-skill.js";
import { CreateSkillError } from "../src/application/use-cases/create-skill/create-skill-errors.js";
import {
  CreateSkillCommand,
  type CreateSkillTerminal,
  type CreateSkillUseCase,
} from "../src/infrastructure/inbound/cli/create-skill-command.js";
import { Cli } from "../src/infrastructure/inbound/cli/cli.js";

interface HarnessOptions {
  stdinInteractive?: boolean;
  stdoutInteractive?: boolean;
  answers?: string[];
  execute?: (request: CreateSkillRequest) => Promise<CreateSkillResult>;
}

function harness(options: HarnessOptions = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const prompts: string[] = [];
  const answers = [...(options.answers ?? [])];
  const terminal: CreateSkillTerminal = {
    isStdinInteractive: () => options.stdinInteractive ?? true,
    isStdoutInteractive: () => options.stdoutInteractive ?? true,
    question: vi.fn((prompt: string) => {
      prompts.push(prompt);
      return Promise.resolve(answers.shift() ?? "");
    }),
  };
  const execute = vi.fn<CreateSkillUseCase["execute"]>(
    options.execute ?? (() => Promise.resolve({ outcome: "completed" })),
  );
  const command = new CreateSkillCommand({ execute }, terminal, {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });
  return { command, execute, prompts, stderr, stdout, terminal };
}

describe("CreateSkillCommand", () => {
  it.each([
    { args: [] },
    { args: ["--agent", "codex"] },
    { args: ["--agent=Codex"] },
    { args: ["--agent=claude"] },
    { args: ["--agent=codex", "--agent=codex"] },
    { args: ["--agent=codex", "extra"] },
  ])(
    "rejects every argument form except exact --agent=codex: %j",
    async ({ args }) => {
      const setup = harness();

      expect(await setup.command.run(args, "/project")).toBe(1);

      expect(setup.execute).not.toHaveBeenCalled();
      expect(setup.prompts).toEqual([]);
      expect(setup.stderr).toEqual([
        "Invalid arguments for command: create-skill\nUsage: happy-machine create-skill --agent=codex",
      ]);
    },
  );

  it.each([
    { stdinInteractive: false, stdoutInteractive: true },
    { stdinInteractive: true, stdoutInteractive: false },
    { stdinInteractive: false, stdoutInteractive: false },
  ])("requires both interactive terminal streams: %j", async (options) => {
    const setup = harness(options);

    expect(await setup.command.run(["--agent=codex"], "/project")).toBe(1);

    expect(setup.execute).not.toHaveBeenCalled();
    expect(setup.prompts).toEqual([]);
    expect(setup.stderr).toEqual([
      "create-skill requires interactive stdin and stdout terminals.",
    ]);
  });

  it.each(["", "   ", "\n\t "])(
    "rejects an empty workflow description before the use case: %j",
    async (description) => {
      const setup = harness({ answers: [description] });

      expect(await setup.command.run(["--agent=codex"], "/project")).toBe(1);

      expect(setup.execute).not.toHaveBeenCalled();
      expect(setup.prompts).toEqual([
        "What workflow are you going to perform? ",
      ]);
      expect(setup.stderr).toEqual([
        "A non-empty workflow description is required.",
      ]);
    },
  );

  it("invokes one use case with the trimmed description, directory, signal, and consent callback", async () => {
    const controller = new AbortController();
    const setup = harness({
      answers: ["  Investigate a production bug  ", "y"],
      execute: async (request) => {
        expect(await request.confirmRecording()).toBe(true);
        return { outcome: "completed" };
      },
    });

    expect(
      await setup.command.run(["--agent=codex"], "/project", controller.signal),
    ).toBe(0);

    expect(setup.execute).toHaveBeenCalledOnce();
    const request = setup.execute.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      workflowDescription: "Investigate a production bug",
      currentDirectory: "/project",
      signal: controller.signal,
    });
    expect(typeof request?.confirmRecording).toBe("function");
    expect(setup.prompts[1]).toContain("complete Codex conversation");
    expect(setup.prompts[1]).toContain("used to create a skill");
    expect(setup.prompts[1]).toContain("dedicated to the workflow");
    expect(setup.prompts[1]).toContain("decline now before recording begins");
    expect(setup.stdout).toEqual([
      "Skill creation finished. Temporary data cleanup completed.",
    ]);
    expect(setup.stderr).toEqual([]);
  });

  it("returns success when explicit consent is declined without starting capture", async () => {
    let captureStarted = false;
    const setup = harness({
      answers: ["Investigate a production bug", "no"],
      execute: async (request) => {
        if (await request.confirmRecording()) captureStarted = true;
        return { outcome: "canceled", stage: "consent" };
      },
    });

    expect(await setup.command.run(["--agent=codex"], "/project")).toBe(0);

    expect(captureStarted).toBe(false);
    expect(setup.execute).toHaveBeenCalledOnce();
    expect(setup.stdout).toEqual([
      "Recording declined. No workflow was captured.",
    ]);
  });

  it.each(["demonstration", "analysis", "generation"] as const)(
    "maps post-consent %s cancellation to exit code 2",
    async (stage) => {
      const setup = harness({
        answers: ["Investigate a production bug"],
        execute: () => Promise.resolve({ outcome: "canceled", stage }),
      });

      expect(await setup.command.run(["--agent=codex"], "/project")).toBe(2);

      expect(setup.stdout[0]).toContain(`canceled during ${stage}`);
      expect(setup.stdout[0]).toContain("cleanup completed");
      expect(setup.stderr).toEqual([]);
    },
  );

  it("renders stable failures without internal messages, causes, or private paths after completed cleanup", async () => {
    const failure = new CreateSkillError(
      "analysis_failed",
      "analysis",
      "captured value from an unsafe upstream message",
      {
        cause: new Error("secret vendor payload"),
        remainingWorkspaces: ["/private/must-not-be-shown"],
      },
    );
    const setup = harness({
      answers: ["Investigate a production bug"],
      execute: async () => Promise.reject(failure),
    });

    expect(await setup.command.run(["--agent=codex"], "/project")).toBe(1);

    expect(setup.stderr[0]).toContain("[analysis_failed] during analysis");
    expect(setup.stderr[0]).toContain("cleanup completed");
    expect(setup.stderr[0]).not.toContain("captured value");
    expect(setup.stderr[0]).not.toContain("secret vendor payload");
    expect(setup.stderr[0]).not.toContain("/private/must-not-be-shown");
  });

  it("reports incomplete cleanup and each remaining private workspace", async () => {
    const failure = new CreateSkillError(
      "generation_start_failed",
      "generation",
      "unsafe upstream message",
      {
        cleanupFailures: [new Error("internal cleanup failure")],
        remainingWorkspaces: ["/private/capture-1", "/private/capture-2"],
      },
    );
    const setup = harness({
      answers: ["Investigate a production bug"],
      execute: async () => Promise.reject(failure),
    });

    expect(await setup.command.run(["--agent=codex"], "/project")).toBe(1);

    expect(setup.stderr[0]).toContain("cleanup is incomplete");
    expect(setup.stderr[0]).toContain(
      "Private workspace requiring manual removal: /private/capture-1",
    );
    expect(setup.stderr[0]).toContain(
      "Private workspace requiring manual removal: /private/capture-2",
    );
    expect(setup.stderr[0]).not.toContain("internal cleanup failure");
    expect(setup.stderr[0]).not.toContain("unsafe upstream message");
  });
});

describe("Cli create-skill routing", () => {
  it("routes argument validation and execution to the focused command", async () => {
    const run = vi.fn().mockResolvedValue(2);
    const cli = new Cli(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { stdout: vi.fn(), stderr: vi.fn() },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { run } as never,
    );
    const signal = new AbortController().signal;

    await expect(
      cli.run(["create-skill", "--agent=codex", "extra"], "/project", signal),
    ).resolves.toBe(2);
    expect(run).toHaveBeenCalledWith(
      ["--agent=codex", "extra"],
      "/project",
      signal,
    );
  });
});
