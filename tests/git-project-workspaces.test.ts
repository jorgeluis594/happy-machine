import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitProjectWorkspaces } from "../src/infrastructure/outbound/project-workspaces/git/git-project-workspaces.js";

const executeFile = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await executeFile("git", ["-C", root, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function repository(): Promise<{ root: string; head: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-git-workspaces-"));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "happy-machine@example.com");
  await git(root, "config", "user.name", "Happy Machine Tests");
  await writeFile(path.join(root, "tracked.txt"), "committed original\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "--quiet", "-m", "initial");
  return { root, head: await git(root, "rev-parse", "HEAD") };
}

describe("Git project workspaces", () => {
  it("creates the main worktree from HEAD without copying or rejecting original changes", async () => {
    const setup = await repository();
    await writeFile(path.join(setup.root, "tracked.txt"), "dirty original\n");
    await writeFile(path.join(setup.root, "untracked.txt"), "local only\n");
    const workspaces = new GitProjectWorkspaces();

    const main = await workspaces.ensureMain({
      projectRoot: setup.root,
      runId: "run-dirty-original",
    });

    expect(main).toMatchObject({
      id: "main",
      role: "main",
      startingHead: setup.head,
      endingHead: setup.head,
      dirty: false,
    });
    expect(main.branch).toBe("happy-machine/run-dirty-original/main");
    expect(await readFile(path.join(main.path, "tracked.txt"), "utf8")).toBe(
      "committed original\n",
    );
    await expect(
      readFile(path.join(main.path, "untracked.txt"), "utf8"),
    ).rejects.toThrow();
    expect(await readFile(path.join(setup.root, "tracked.txt"), "utf8")).toBe(
      "dirty original\n",
    );
    expect(await readFile(path.join(setup.root, "untracked.txt"), "utf8")).toBe(
      "local only\n",
    );
    await expect(workspaces.observe(main)).resolves.toEqual({
      endingHead: setup.head,
      dirty: false,
    });
  });

  it("creates independent children at one exact committed main HEAD while ignoring dirty main files", async () => {
    const setup = await repository();
    const workspaces = new GitProjectWorkspaces();
    const main = await workspaces.ensureMain({
      projectRoot: setup.root,
      runId: "run-fan-out",
    });
    await writeFile(path.join(main.path, "inherited.txt"), "committed main\n");
    await git(main.path, "add", "inherited.txt");
    await git(main.path, "commit", "--quiet", "-m", "main handoff");
    const fanOutHead = await git(main.path, "rev-parse", "HEAD");
    await writeFile(path.join(main.path, "tracked.txt"), "dirty main\n");
    await writeFile(path.join(main.path, "main-only.txt"), "not inherited\n");

    const children = await Promise.all(
      ["alpha", "beta", "gamma"].map((taskId) =>
        workspaces.ensureChild({
          projectRoot: setup.root,
          runId: "run-fan-out",
          stateId: "checks",
          visitNumber: 1,
          taskId,
          startingHead: fanOutHead,
        }),
      ),
    );

    expect(new Set(children.map((child) => child.path))).toHaveLength(3);
    expect(new Set(children.map((child) => child.branch))).toHaveLength(3);
    expect(children.map((child) => child.startingHead)).toEqual([
      fanOutHead,
      fanOutHead,
      fanOutHead,
    ]);
    for (const [index, child] of children.entries()) {
      expect(child.provenance).toEqual({
        stateId: "checks",
        visitNumber: 1,
        taskId: ["alpha", "beta", "gamma"][index],
      });
      expect(
        await readFile(path.join(child.path, "inherited.txt"), "utf8"),
      ).toBe("committed main\n");
      expect(await readFile(path.join(child.path, "tracked.txt"), "utf8")).toBe(
        "committed original\n",
      );
      await expect(
        readFile(path.join(child.path, "main-only.txt"), "utf8"),
      ).rejects.toThrow();
    }
  });

  it("idempotently adopts exact deterministic main and child worktrees", async () => {
    const setup = await repository();
    const workspaces = new GitProjectWorkspaces();
    const request = {
      projectRoot: setup.root,
      runId: "run-idempotent",
    };
    const main = await workspaces.ensureMain(request);
    await expect(workspaces.ensureMain(request)).resolves.toEqual(main);
    const childRequest = {
      ...request,
      stateId: "parallel",
      visitNumber: 2,
      taskId: "worker",
      startingHead: main.startingHead,
    };
    const child = await workspaces.ensureChild(childRequest);
    await expect(workspaces.ensureChild(childRequest)).resolves.toEqual(child);

    const registeredPaths = (
      await git(setup.root, "worktree", "list", "--porcelain")
    )
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    expect(registeredPaths).toHaveLength(3);
  });

  it("refuses a deterministic branch collision without modifying it", async () => {
    const setup = await repository();
    await git(
      setup.root,
      "branch",
      "happy-machine/run-conflict/main",
      setup.head,
    );
    const before = await git(
      setup.root,
      "rev-parse",
      "happy-machine/run-conflict/main",
    );

    await expect(
      new GitProjectWorkspaces().ensureMain({
        projectRoot: setup.root,
        runId: "run-conflict",
      }),
    ).rejects.toMatchObject({ code: "workspace_preparation_failed" });
    expect(
      await git(setup.root, "rev-parse", "happy-machine/run-conflict/main"),
    ).toBe(before);
  });

  it("observes committed and uncommitted child state", async () => {
    const setup = await repository();
    const workspaces = new GitProjectWorkspaces();
    const child = await workspaces.ensureChild({
      projectRoot: setup.root,
      runId: "run-observe",
      stateId: "checks",
      visitNumber: 1,
      taskId: "alpha",
      startingHead: setup.head,
    });
    await writeFile(path.join(child.path, "child.txt"), "committed child\n");
    await git(child.path, "add", "child.txt");
    await git(child.path, "commit", "--quiet", "-m", "child commit");
    const endingHead = await git(child.path, "rev-parse", "HEAD");
    await writeFile(path.join(child.path, "dirty.txt"), "uncommitted child\n");

    await expect(workspaces.observe(child)).resolves.toEqual({
      endingHead,
      dirty: true,
    });
  });

  it("leaves a managed branch and its commit reachable after manual worktree removal", async () => {
    const setup = await repository();
    const workspaces = new GitProjectWorkspaces();
    const child = await workspaces.ensureChild({
      projectRoot: setup.root,
      runId: "run-retain-branch",
      stateId: "checks",
      visitNumber: 1,
      taskId: "alpha",
      startingHead: setup.head,
    });
    await writeFile(path.join(child.path, "child.txt"), "retained commit\n");
    await git(child.path, "add", "child.txt");
    await git(child.path, "commit", "--quiet", "-m", "retain me");
    const childHead = await git(child.path, "rev-parse", "HEAD");

    await git(setup.root, "worktree", "remove", child.path);

    expect(await git(setup.root, "rev-parse", child.branch)).toBe(childHead);
    await expect(
      git(setup.root, "cat-file", "-e", `${childHead}^{commit}`),
    ).resolves.toBe("");
  });

  it("removes only a clean, exactly registered worktree and preserves its branch and commit", async () => {
    const setup = await repository();
    const workspaces = new GitProjectWorkspaces();
    const main = await workspaces.ensureMain({
      projectRoot: setup.root,
      runId: "run-cleanup-clean",
    });
    await writeFile(path.join(main.path, "result.txt"), "committed\n");
    await git(main.path, "add", "result.txt");
    await git(main.path, "commit", "--quiet", "-m", "result");
    const endingHead = await git(main.path, "rev-parse", "HEAD");

    await expect(
      workspaces.remove({
        projectRoot: setup.root,
        runId: "run-cleanup-clean",
        worktree: main,
      }),
    ).resolves.toEqual({
      result: "removed",
      observation: { endingHead, dirty: false },
    });
    await expect(stat(main.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(setup.root, "rev-parse", main.branch)).toBe(endingHead);
  });

  it("refuses to remove a dirty worktree and reports its current condition", async () => {
    const setup = await repository();
    const workspaces = new GitProjectWorkspaces();
    const main = await workspaces.ensureMain({
      projectRoot: setup.root,
      runId: "run-cleanup-dirty",
    });
    await writeFile(path.join(main.path, "uncommitted.txt"), "keep me\n");

    await expect(
      workspaces.remove({
        projectRoot: setup.root,
        runId: "run-cleanup-dirty",
        worktree: main,
      }),
    ).resolves.toEqual({
      result: "retained_dirty",
      observation: { endingHead: setup.head, dirty: true },
    });
    await expect(stat(main.path)).resolves.toMatchObject({});
    expect(
      await readFile(path.join(main.path, "uncommitted.txt"), "utf8"),
    ).toBe("keep me\n");
  });

  it("refuses cleanup when durable metadata does not identify a worktree owned by the run", async () => {
    const setup = await repository();
    const workspaces = new GitProjectWorkspaces();
    const main = await workspaces.ensureMain({
      projectRoot: setup.root,
      runId: "run-owner",
    });

    await expect(
      workspaces.remove({
        projectRoot: setup.root,
        runId: "another-run",
        worktree: main,
      }),
    ).rejects.toThrow("does not belong to run another-run");
    await expect(stat(main.path)).resolves.toMatchObject({});
  });
});
