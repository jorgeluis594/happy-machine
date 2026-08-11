import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { RunRecord } from "../src/domain/execution/run.js";
import { FilesystemRunRepository } from "../src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.js";

const executeFile = promisify(execFile);

async function area() {
  const root = await mkdtemp(path.join(os.tmpdir(), "happy-result-"));
  const output = path.join(root, "output");
  const result = path.join(root, "result.json");
  await mkdir(output);
  return { root, output, result };
}

async function parse(
  repository: FilesystemRunRepository,
  value: unknown,
  allowed = ["approved"],
) {
  const paths = await area();
  await writeFile(paths.result, `${JSON.stringify(value)}\n`);
  return repository.readResult(paths.result, paths.output, allowed);
}

function run(root: string): RunRecord {
  return {
    id: "run-test",
    workflowId: "workflow",
    workflowPath: path.join(root, "workflow.yaml"),
    projectRoot: root,
    definitionSnapshot: {
      identity: "sha256:test",
      directory: path.join(root, "snapshot"),
      manifestPath: path.join(root, "snapshot", "manifest.json"),
      inputs: [],
    },
    status: "running",
    createdAt: "2026-08-11T00:00:00.000Z",
    deadlineAt: "2026-08-12T00:00:00.000Z",
    transitionCount: 0,
    visits: [
      {
        type: "agent",
        stateId: "review",
        number: 1,
        contextPath: path.join(root, "context.md"),
        task: {
          id: "review-task",
          attempts: [
            {
              id: "attempt",
              number: 1,
              status: "running",
              controlWorkspace: root,
              contextPath: path.join(root, "context.md"),
              outputDirectory: path.join(root, "output"),
              resultPath: path.join(root, "result.json"),
              logs: { stdout: "", stderr: "" },
              documents: [],
            },
          ],
        },
      },
    ],
    documents: [],
    events: [],
  };
}

function stage(
  repository: FilesystemRunRepository,
  current: RunRecord,
  outputDirectory: string,
  names: readonly string[],
) {
  const visit = current.visits[0];
  if (visit.type !== "agent") throw new Error("expected agent visit");
  return repository.stageDocuments(
    current,
    visit,
    visit.task,
    outputDirectory,
    names,
  );
}

describe("normal result validation", () => {
  const repository = new FilesystemRunRepository();

  it.each([
    [null, "object"],
    [[], "object"],
    [{ documents: [] }, "unknown outcome"],
    [{ outcome: 1, documents: [] }, "unknown outcome"],
    [{ outcome: "uncertain", documents: [] }, "unknown outcome"],
    [{ outcome: "approved" }, "documents must be an array"],
    [
      { outcome: "approved", documents: "report.md" },
      "documents must be an array",
    ],
    [{ outcome: "approved", documents: [1] }, "documents must be an array"],
  ])("rejects an incomplete or invalid contract %#", async (value, message) => {
    await expect(parse(repository, value)).rejects.toThrow(message);
  });

  it("rejects a missing or malformed result", async () => {
    const paths = await area();
    await expect(
      repository.readResult(paths.result, paths.output, ["approved"]),
    ).rejects.toThrow("Missing or invalid result.json");
    await writeFile(paths.result, "{broken");
    await expect(
      repository.readResult(paths.result, paths.output, ["approved"]),
    ).rejects.toThrow("Missing or invalid result.json");
  });

  it("accepts serializable diagnostic error without treating it as control", async () => {
    await expect(
      parse(repository, {
        outcome: "approved",
        documents: [],
        error: { code: "agent-note", retryable: false, details: [1, null] },
      }),
    ).resolves.toMatchObject({
      outcome: "approved",
      error: { code: "agent-note", retryable: false },
    });
  });

  it.each(["/tmp/outside.md", "../outside.md", "", "report.txt", "missing.md"])(
    "rejects invalid document path %s",
    async (name) => {
      const paths = await area();
      await writeFile(
        paths.result,
        JSON.stringify({ outcome: "approved", documents: [name] }),
      );
      await expect(
        repository.readResult(paths.result, paths.output, ["approved"]),
      ).rejects.toThrow("Invalid result document");
    },
  );

  it("rejects directories and symbolic links, including links that escape the output area", async () => {
    const paths = await area();
    await mkdir(path.join(paths.output, "directory.md"));
    const outside = path.join(paths.root, "outside.md");
    await writeFile(outside, "outside\n");
    await symlink(outside, path.join(paths.output, "link.md"));
    for (const name of ["directory.md", "link.md"]) {
      await writeFile(
        paths.result,
        JSON.stringify({ outcome: "approved", documents: [name] }),
      );
      await expect(
        repository.readResult(paths.result, paths.output, ["approved"]),
      ).rejects.toThrow("Invalid result document");
    }
  });

  it("rejects a special file", async () => {
    const paths = await area();
    const fifo = path.join(paths.output, "stream.md");
    await executeFile("mkfifo", [fifo]);
    await writeFile(
      paths.result,
      JSON.stringify({ outcome: "approved", documents: ["stream.md"] }),
    );
    await expect(
      repository.readResult(paths.result, paths.output, ["approved"]),
    ).rejects.toThrow("Invalid result document");
  });

  it("validates the whole batch before copying any document", async () => {
    const paths = await area();
    await writeFile(path.join(paths.output, "valid.md"), "valid\n");
    await expect(
      stage(repository, run(paths.root), paths.output, [
        "valid.md",
        "missing.md",
      ]),
    ).rejects.toThrow("Invalid result document");
    await expect(
      readFile(
        path.join(
          paths.root,
          ".happy-machine",
          "runs",
          "run-test",
          "states",
          "review",
          "visits",
          "1",
          "tasks",
          "review-task",
          "documents",
          "valid.md",
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects duplicate and previously committed provenance without overwriting", async () => {
    const paths = await area();
    await writeFile(path.join(paths.output, "report.md"), "original\n");
    const current = run(paths.root);
    const [record] = await stage(repository, current, paths.output, [
      "report.md",
    ]);
    current.documents.push(record);
    await writeFile(path.join(paths.output, "report.md"), "replacement\n");
    await expect(
      stage(repository, current, paths.output, ["report.md"]),
    ).rejects.toThrow("provenance collision");
    await expect(readFile(record.durablePath, "utf8")).resolves.toBe(
      "original\n",
    );
  });
});
