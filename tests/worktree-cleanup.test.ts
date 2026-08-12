/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from "vitest";
import { CleanupWorktrees } from "../src/application/use-cases/cleanup-worktrees.js";
import type { RunRecord } from "../src/domain/execution/run.js";
import type { ProjectWorkspaces } from "../src/ports/project-workspaces.js";
import type { RemoveWorkspaceRequest } from "../src/ports/project-workspaces.js";
import type { RunRepository } from "../src/ports/run-repository.js";
import { Cli } from "../src/infrastructure/inbound/cli/cli.js";

function run(status: RunRecord["status"] = "succeeded"): RunRecord {
  return {
    id: "run_cleanup",
    workflowId: "workflow",
    workflowPath: "/project/workflow.yaml",
    projectRoot: "/project",
    workspace: {
      mode: "worktree",
      worktrees: ["main", "dirty", "other"].map((id) => ({
        id,
        role: "main" as const,
        path: `/project/.happy-machine/worktrees/run_cleanup/${id}`,
        branch: `happy-machine/run_cleanup/${id}`,
        startingHead: "abc",
        endingHead: "abc",
        dirty: false,
      })),
    },
    definitionSnapshot: {
      identity: "sha256:test",
      directory: "/project/.happy-machine/runs/run_cleanup/snapshot",
      manifestPath:
        "/project/.happy-machine/runs/run_cleanup/snapshot/manifest.json",
      inputs: [],
    },
    status,
    createdAt: "2026-08-11T12:00:00.000Z",
    deadlineAt: "2026-08-11T13:00:00.000Z",
    transitionCount: 1,
    visits: [],
    documents: [],
    events: [],
  };
}

function harness(initial = run()) {
  let stored = structuredClone(initial);
  const repository = {
    discoverProjectRoot: vi.fn(async () => "/project"),
    load: vi.fn(async () => ({ run: structuredClone(stored), definition: {} })),
    save: vi.fn(async (value: RunRecord) => {
      stored = structuredClone(value);
    }),
    claimCleanupPrompt: vi.fn(
      async (_root: string, _id: string, at: string) => {
        if (stored.cleanup?.promptShownAt) return undefined;
        stored.cleanup = {
          promptShownAt: at,
          decision: "pending",
          evaluations: [],
        };
        return structuredClone(stored);
      },
    ),
  } as unknown as RunRepository;
  const workspaces = {
    remove: vi.fn(async ({ worktree }: RemoveWorkspaceRequest) => ({
      result: worktree.id === "dirty" ? "retained_dirty" : "removed",
      observation: { endingHead: "def", dirty: worktree.id === "dirty" },
    })),
  } as unknown as ProjectWorkspaces;
  let tick = 0;
  const cleanup = new CleanupWorktrees(
    repository,
    workspaces,
    () => new Date(Date.UTC(2026, 7, 11, 12, 0, tick++)),
  );
  return { cleanup, repository, workspaces, stored: () => stored };
}

describe("worktree cleanup", () => {
  it("processes clean and dirty worktrees independently and records every result", async () => {
    const setup = harness();
    const result = await setup.cleanup.cleanup("/project", "run_cleanup");

    expect(result.evaluations.map(({ result }) => result)).toEqual([
      "removed",
      "retained_dirty",
      "removed",
    ]);
    expect(result.evaluations[1]).toMatchObject({
      path: expect.stringContaining("/dirty"),
      dirty: true,
      message: "Uncommitted changes require manual attention",
    });
    expect(setup.stored().cleanup).toMatchObject({
      decision: "cleanup",
      evaluations: result.evaluations,
    });
    expect(
      setup
        .stored()
        .events.filter((event) => event.type === "worktree_cleanup_evaluated"),
    ).toHaveLength(3);

    await setup.cleanup.cleanup("/project", "run_cleanup");
    expect(setup.workspaces.remove).toHaveBeenCalledTimes(4);
  });

  it("rejects cleanup before the complete run is terminal", async () => {
    const setup = harness(run("running"));
    await expect(
      setup.cleanup.cleanup("/project", "run_cleanup"),
    ).rejects.toThrow("cleanup requires a terminal run");
    expect(setup.workspaces.remove).not.toHaveBeenCalled();
  });

  it("succeeds in direct mode without evaluating worktrees", async () => {
    const direct = run();
    direct.workspace = { mode: "direct", worktrees: [] };
    const setup = harness(direct);
    await expect(
      setup.cleanup.cleanup("/project", "run_cleanup"),
    ).resolves.toMatchObject({ evaluations: [] });
  });

  it("prompts once, retains on the default answer, and never prompts noninteractively", async () => {
    const setup = harness();
    const output: string[] = [];
    const confirm = vi.fn(async () => false);
    const terminalRun = run();
    const app = new Cli(
      { execute: vi.fn(async () => terminalRun) } as never,
      {} as never,
      {} as never,
      {} as never,
      { stdout: (message) => output.push(message), stderr: vi.fn() },
      undefined,
      setup.cleanup,
      { isInteractive: () => true, confirm },
    );

    await app.run(["execute", "workflow.yaml"], "/project");
    await app.run(["execute", "workflow.yaml"], "/project");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(setup.stored().cleanup?.decision).toBe("retain");

    const noninteractive = harness();
    const noPrompt = vi.fn(async () => true);
    const detached = new Cli(
      { execute: vi.fn(async () => terminalRun) } as never,
      {} as never,
      {} as never,
      {} as never,
      { stdout: vi.fn(), stderr: vi.fn() },
      undefined,
      noninteractive.cleanup,
      { isInteractive: () => false, confirm: noPrompt },
    );
    await detached.run(["execute", "workflow.yaml"], "/project");
    expect(noPrompt).not.toHaveBeenCalled();
    expect(noninteractive.repository.claimCleanupPrompt).not.toHaveBeenCalled();
  });

  it("applies the same safe cleanup when an interactive user accepts", async () => {
    const setup = harness();
    const stdout: string[] = [];
    const app = new Cli(
      { execute: vi.fn(async () => run()) } as never,
      {} as never,
      {} as never,
      {} as never,
      { stdout: (message) => stdout.push(message), stderr: vi.fn() },
      undefined,
      setup.cleanup,
      { isInteractive: () => true, confirm: vi.fn(async () => true) },
    );

    expect(await app.run(["execute", "workflow.yaml"], "/project")).toBe(0);
    expect(stdout).toContain(
      "Retained dirty worktree requiring manual attention: /project/.happy-machine/worktrees/run_cleanup/dirty",
    );
    expect(setup.stored().cleanup?.evaluations).toHaveLength(3);
  });

  it.each(["execute", "resume", "cancel"] as const)(
    "does not await input for noninteractive %s",
    async (command) => {
      const setup = harness();
      const confirm = vi.fn(async () => true);
      const terminalRun = run(command === "cancel" ? "canceled" : "succeeded");
      const app = new Cli(
        {
          execute: vi.fn(async () => terminalRun),
        } as never,
        {
          recover: vi.fn(async () => terminalRun),
        } as never,
        {
          cancel: vi.fn(async () => terminalRun),
        } as never,
        {} as never,
        { stdout: vi.fn(), stderr: vi.fn() },
        undefined,
        setup.cleanup,
        { isInteractive: () => false, confirm },
      );
      const argv =
        command === "execute"
          ? [command, "workflow.yaml"]
          : [command, "run_cleanup"];

      await app.run(argv, "/project");
      expect(confirm).not.toHaveBeenCalled();
      expect(setup.repository.claimCleanupPrompt).not.toHaveBeenCalled();
    },
  );
});
