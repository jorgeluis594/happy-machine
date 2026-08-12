import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import type { RunRecord } from "../src/domain/execution/run.js";
import { GitProjectWorkspaces } from "../src/infrastructure/outbound/project-workspaces/git/git-project-workspaces.js";

const executeFile = promisify(execFile);
const entry = path.resolve("dist/src/main.js");

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await executeFile("git", ["-C", root, ...args]);
  return stdout.trim();
}

async function terminalRun(): Promise<{
  root: string;
  runPath: string;
  worktreePath: string;
  snapshotPath: string;
  logPath: string;
  documentPath: string;
  branch: string;
  head: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-cleanup-pty-"));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "happy-machine@example.com");
  await git(root, "config", "user.name", "Happy Machine Tests");
  await writeFile(path.join(root, "tracked.txt"), "initial\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "--quiet", "-m", "initial");
  const worktree = await new GitProjectWorkspaces().ensureMain({
    projectRoot: root,
    runId: "run_pty",
  });
  const runDirectory = path.join(root, ".happy-machine", "runs", "run_pty");
  const snapshotDirectory = path.join(runDirectory, "snapshot");
  const logPath = path.join(runDirectory, "logs", "stdout.log");
  const documentPath = path.join(runDirectory, "documents", "result.md");
  await mkdir(snapshotDirectory, { recursive: true });
  await mkdir(path.dirname(logPath), { recursive: true });
  await mkdir(path.dirname(documentPath), { recursive: true });
  await writeFile(logPath, "durable log\n");
  await writeFile(documentPath, "durable document\n");
  const snapshotPath = path.join(snapshotDirectory, "manifest.json");
  await writeFile(
    snapshotPath,
    `${JSON.stringify({ effectiveDefinition: { workflowId: "workflow" } })}\n`,
  );
  const run: RunRecord = {
    id: "run_pty",
    workflowId: "workflow",
    workflowPath: path.join(root, "workflow.yaml"),
    projectRoot: root,
    workspace: { mode: "worktree", worktrees: [worktree] },
    definitionSnapshot: {
      identity: "sha256:test",
      directory: snapshotDirectory,
      manifestPath: path.join(snapshotDirectory, "manifest.json"),
      inputs: [],
    },
    status: "succeeded",
    createdAt: "2026-08-11T12:00:00.000Z",
    deadlineAt: "2026-08-11T13:00:00.000Z",
    transitionCount: 1,
    visits: [],
    documents: [
      {
        stateId: "state",
        visitNumber: 1,
        taskId: "task",
        name: "result.md",
        internalPath: "documents/result.md",
        durablePath: documentPath,
        sha256: "test",
      },
    ],
    events: [
      {
        sequence: 1,
        type: "run_terminal",
        at: "2026-08-11T12:00:01.000Z",
        data: { status: "succeeded" },
      },
    ],
  };
  const runPath = path.join(runDirectory, "run.json");
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`);
  return {
    root,
    runPath,
    worktreePath: worktree.path,
    snapshotPath,
    logPath,
    documentPath,
    branch: worktree.branch,
    head: worktree.endingHead,
  };
}

function ptyCancel(root: string, answer?: string): Promise<string> {
  const driver = `
import os, pty, sys
command = sys.argv[1:-1]
answer = sys.argv[-1]
pid, fd = pty.fork()
if pid == 0:
    os.execv(command[0], command)
os.write(fd, b"\\x04" if answer == "__EOF__" else answer.encode())
while True:
    try:
        data = os.read(fd, 4096)
        if not data:
            break
        os.write(1, data)
    except OSError:
        break
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "python3",
      [
        "-c",
        driver,
        process.execPath,
        entry,
        "cancel",
        "run_pty",
        answer ?? "__EOF__",
      ],
      { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`PTY command exited ${String(code)}: ${output}`));
    });
    child.stdin.end();
  });
}

beforeAll(async () => {
  await executeFile("npm", ["run", "build"], { cwd: path.resolve(".") });
});

describe("worktree cleanup prompt in a pseudo-terminal", () => {
  it("removes a clean worktree when cleanup is accepted", async () => {
    const setup = await terminalRun();
    const output = await ptyCancel(setup.root, "y\n");
    expect(output).toContain("Clean up managed worktrees? [y/N]");
    expect(output).toContain("Removed clean worktree:");
    await expect(stat(setup.worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(setup.snapshotPath, "utf8")).toContain("workflow");
    expect(await readFile(setup.logPath, "utf8")).toBe("durable log\n");
    expect(await readFile(setup.documentPath, "utf8")).toBe(
      "durable document\n",
    );
    expect(await git(setup.root, "rev-parse", setup.branch)).toBe(setup.head);
    const stored = JSON.parse(
      await readFile(setup.runPath, "utf8"),
    ) as RunRecord;
    expect(stored.events.map((event) => event.type)).toContain("run_terminal");
    expect(stored.documents).toHaveLength(1);
  });

  it.each([
    ["an empty default response", "\n"],
    ["no response before EOF", undefined],
  ])("retains on %s", async (_label, answer) => {
    const setup = await terminalRun();
    const output = await ptyCancel(setup.root, answer);
    expect(output).toContain("Clean up managed worktrees? [y/N]");
    expect(output).toContain("Managed worktrees retained.");
    await expect(stat(setup.worktreePath)).resolves.toMatchObject({});
    const stored = JSON.parse(
      await readFile(setup.runPath, "utf8"),
    ) as RunRecord;
    expect(stored.cleanup?.decision).toBe("retain");
  });

  it("prompts only once across repeated attached observations", async () => {
    const setup = await terminalRun();
    const first = await ptyCancel(setup.root, "\n");
    const second = await ptyCancel(setup.root, "\n");
    expect(
      `${first}${second}`.match(/Clean up managed worktrees/g),
    ).toHaveLength(1);
  });
});
