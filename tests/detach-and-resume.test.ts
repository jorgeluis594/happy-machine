import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { RunRecord } from "../src/domain/execution/run.js";

const executeFile = promisify(execFile);
const fixture = path.resolve("tests/fixtures/fake-orca.mjs");
const entry = path.resolve("dist/src/main.js");

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 600; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for controlled CLI fixture");
}

function runProcess(args: string[], cwd: string) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: { ...process.env, ORCA_CLI_COMMAND: fixture },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const closed = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => child.on("close", (code, signal) => resolve({ code, signal })),
  );
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
}

beforeAll(async () => {
  await chmod(fixture, 0o755);
  await executeFile("npm", ["run", "build"], { cwd: path.resolve(".") });
});

describe("detach and resume CLI", () => {
  it("exits 130 on SIGINT, leaves Orca running, and resumes from immutable evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "happy-detach-"));
    await mkdir(path.join(root, "agents"));
    await mkdir(path.join(root, "workflows"));
    const input = path.join(root, "request.md");
    const workflow = path.join(root, "workflows", "resume.yaml");
    await writeFile(input, "original input\n");
    await writeFile(
      path.join(root, "agents", "worker.md"),
      "# Worker\nOriginal instructions.\n",
    );
    await writeFile(
      path.join(root, "happy-machine.yaml"),
      `version: 1
agents:
  worker:
    instructions: agents/worker.md
    model: original-model
defaults:
  attempt_timeout: 30s
  workflow_timeout: 2m
  controller_lease: 20s
`,
    );
    await writeFile(
      workflow,
      `version: 1
id: resumable
initial_state: first
states:
  first:
    type: agent
    agent: worker
    prompt: First original prompt
    outcomes:
      approved: second
  second:
    type: agent
    agent: worker
    prompt: Second original prompt
    outcomes:
      approved: $succeeded
`,
    );
    await writeFile(path.join(root, ".fake-block-check"), "block\n");

    const executing = runProcess(["execute", workflow, "--input", input], root);
    await waitFor(() => existsSync(path.join(root, ".fake-check-waiting")));
    const runId = executing.stdout().trim().split("\n")[0];
    expect(runId).toMatch(/^run_/);
    executing.child.kill("SIGINT");
    const detached = await executing.closed;
    expect(detached).toEqual({ code: 130, signal: null });

    const runPath = path.join(
      root,
      ".happy-machine",
      "runs",
      runId,
      "run.json",
    );
    const stored = JSON.parse(await readFile(runPath, "utf8")) as RunRecord;
    expect(stored).toMatchObject({
      status: "running",
      controllerStatus: "detached",
    });
    expect(stored.controllerLease).toBeUndefined();
    const callsBeforeResume = await readFile(
      path.join(root, ".fake-orca-calls.jsonl"),
      "utf8",
    );
    expect(callsBeforeResume).not.toContain('"orchestration"');
    expect(callsBeforeResume.match(/"send"/g)).toHaveLength(1);

    const firstAttempt = stored.visits[0];
    if (firstAttempt?.type !== "agent") throw new Error("expected first visit");
    await writeFile(
      path.join(root, ".fake-recovery-identity"),
      firstAttempt.task.attempts[0].id,
    );
    await writeFile(path.join(root, ".fake-recovery-state"), "succeeded");
    await writeFile(path.join(root, ".fake-release-check"), "release\n");
    await writeFile(input, "edited input\n");
    await writeFile(workflow, "version: 1\nid: edited\n");
    await writeFile(
      path.join(root, "agents", "worker.md"),
      "# Worker\nEdited instructions.\n",
    );

    const resuming = runProcess(["resume", runId], root);
    const resumed = await resuming.closed;
    expect(resumed, resuming.stderr()).toEqual({ code: 0, signal: null });
    const completed = JSON.parse(await readFile(runPath, "utf8")) as RunRecord;
    expect(completed.status).toBe("succeeded");
    expect(completed.visits.map((visit) => visit.stateId)).toEqual([
      "first",
      "second",
    ]);
    const contracts = (
      await readFile(path.join(root, ".fake-contracts.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line) as unknown);
    expect(contracts).toHaveLength(2);
    expect(contracts[1]).toMatchObject({ model: "original-model" });
    const prompts = (
      await readFile(path.join(root, ".fake-prompts.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string);
    expect(prompts).toEqual([
      "First original prompt",
      "Second original prompt",
    ]);
    expect(
      await readFile(path.join(root, ".fake-agent-input-content"), "utf8"),
    ).toBe("original input\n");
    const allCalls = await readFile(
      path.join(root, ".fake-orca-calls.jsonl"),
      "utf8",
    );
    expect(allCalls).not.toContain('"orchestration"');
    expect(allCalls.match(/"send"/g)).toHaveLength(2);
  }, 30_000);
});
