import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Cli } from "../src/infrastructure/inbound/cli/cli.js";

const commands = [
  {
    command: "help",
    usage: "happy-machine help [COMMAND]",
    argument: "COMMAND",
  },
  {
    command: "execute",
    usage:
      "happy-machine execute WORKFLOW_PATH [--input DOCUMENT.md ...] [--debug]",
    argument: "WORKFLOW_PATH",
  },
  {
    command: "resume",
    usage: "happy-machine resume RUN_ID [--debug]",
    argument: "RUN_ID",
  },
  {
    command: "cancel",
    usage: "happy-machine cancel RUN_ID [--debug]",
    argument: "RUN_ID",
  },
  {
    command: "cleanup",
    usage: "happy-machine cleanup RUN_ID",
    argument: "RUN_ID",
  },
  {
    command: "status",
    usage: "happy-machine status RUN_ID",
    argument: "RUN_ID",
  },
  {
    command: "history",
    usage: "happy-machine history [RUN_ID]",
    argument: "RUN_ID",
  },
] as const;

function harness() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls = {
    execute: vi.fn(),
    recover: vi.fn(),
    cancel: vi.fn(),
    status: vi.fn(),
    history: vi.fn(),
    cleanup: vi.fn(),
    claimPrompt: vi.fn(),
    retain: vi.fn(),
  };
  return {
    app: new Cli(
      { execute: calls.execute } as never,
      { recover: calls.recover } as never,
      { cancel: calls.cancel } as never,
      { status: calls.status, history: calls.history } as never,
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
      undefined,
      {
        cleanup: calls.cleanup,
        claimPrompt: calls.claimPrompt,
        retain: calls.retain,
      } as never,
    ),
    calls,
    stdout,
    stderr,
  };
}

function expectNoCalls(calls: ReturnType<typeof harness>["calls"]): void {
  for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
}

describe("happy-machine help", () => {
  it.each([
    { argv: [] },
    { argv: ["help"] },
    { argv: ["--help"] },
    { argv: ["-h"] },
  ])("renders global help for %j", async ({ argv }) => {
    const setup = harness();

    expect(await setup.app.run(argv, "/project")).toBe(0);

    expect(setup.stderr).toEqual([]);
    expect(setup.stdout).toHaveLength(1);
    const output = setup.stdout[0] ?? "";
    expect(output).toContain("Happy Machine executes durable agent workflows");
    expect(output).toContain("Usage:");
    expect(output).toContain("happy-machine <command> [arguments] [options]");
    for (const { command } of commands)
      expect(output).toMatch(new RegExp(`^  ${command}\\s`, "m"));
    expect(output).toContain("happy-machine help <command>");
    expectNoCalls(setup.calls);
  });

  it.each(commands)(
    "renders all three specific-help forms for $command",
    async ({ command, usage, argument }) => {
      const forms = [
        ["help", command],
        [command, "--help"],
        [command, "-h"],
      ];
      const outputs: string[] = [];

      for (const argv of forms) {
        const setup = harness();
        expect(await setup.app.run(argv, "/project")).toBe(0);
        expect(setup.stderr).toEqual([]);
        expect(setup.stdout).toHaveLength(1);
        const output = setup.stdout[0] ?? "";
        outputs.push(output);
        expect(output).toContain(`Usage:\n  ${usage}`);
        expect(output).toContain("Arguments:");
        expect(output).toContain(argument);
        expect(output).toContain("Options:");
        expect(output).toContain("-h, --help");
        if (command === "execute") {
          expect(output).toContain("--input DOCUMENT.md");
          expect(output).toContain("May be repeated.");
        }
        expectNoCalls(setup.calls);
      }

      expect(new Set(outputs)).toHaveLength(1);
    },
  );

  it("does not create durable state while rendering help", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-help-"));
    const setup = harness();
    const invocations = [
      [],
      ["help"],
      ["--help"],
      ["-h"],
      ...commands.flatMap(({ command }) => [
        ["help", command],
        [command, "--help"],
        [command, "-h"],
      ]),
    ];

    for (const argv of invocations)
      expect(await setup.app.run(argv, root)).toBe(0);

    expectNoCalls(setup.calls);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("reports an unknown command on stderr", async () => {
    const setup = harness();

    expect(await setup.app.run(["unknown"], "/project")).toBe(1);

    expect(setup.stdout).toEqual([]);
    expect(setup.stderr).toEqual([
      "Unknown command: unknown\nTry 'happy-machine help' for more information.",
    ]);
    expectNoCalls(setup.calls);
  });

  it.each([
    ["help", "unknown"],
    ["help", "execute", "extra"],
    ["execute", "workflow.yaml", "--help"],
  ])("rejects invalid approved-help lookalike %j", async (...argv) => {
    const setup = harness();
    const command = argv[0] ?? "";

    expect(await setup.app.run(argv, "/project")).toBe(1);

    expect(setup.stdout).toEqual([]);
    expect(setup.stderr).toEqual([
      `Invalid arguments for command: ${command}\nTry 'happy-machine help ${command}' for more information.`,
    ]);
    expectNoCalls(setup.calls);
  });
});

describe("--debug parsing", () => {
  it.each([
    ["execute", ["execute", "--debug", "workflow.yaml"], "execute"],
    ["execute trailing", ["execute", "workflow.yaml", "--debug"], "execute"],
    [
      "execute among inputs",
      ["execute", "workflow.yaml", "--input", "a.md", "--debug"],
      "execute",
    ],
    ["resume", ["resume", "--debug", "run_1"], "recover"],
    ["resume trailing", ["resume", "run_1", "--debug"], "recover"],
    ["cancel", ["cancel", "--debug", "run_1"], "cancel"],
  ])("accepts %s", async (_label, argv, callName) => {
    const setup = harness();
    setup.calls.execute.mockResolvedValue({ id: "run_1", status: "succeeded" });
    setup.calls.recover.mockResolvedValue({ id: "run_1", status: "succeeded" });
    setup.calls.cancel.mockResolvedValue({ id: "run_1", status: "canceled" });
    await setup.app.run(argv, "/project");
    expect(
      setup.calls[callName as "execute" | "recover" | "cancel"],
    ).toHaveBeenCalledOnce();
  });

  it.each([
    ["execute", "workflow.yaml", "--debug", "--debug"],
    ["resume", "run_1", "--debug=yes"],
    ["cancel", "--debug=false", "run_1"],
    ["status", "run_1", "--debug"],
    ["history", "--debug"],
    ["cleanup", "run_1", "--debug"],
  ])("rejects %j", async (...argv) => {
    const setup = harness();
    expect(await setup.app.run(argv, "/project")).toBe(1);
    expectNoCalls(setup.calls);
  });
});
