import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FilesystemSkillCaptureCleanupError,
  FilesystemSkillCaptureStore,
} from "../src/infrastructure/outbound/skill-capture-store/filesystem/filesystem-skill-capture-store.js";

const roots: string[] = [];
const userId = process.getuid?.();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  options: {
    processId?: number;
    processIsAlive?: (pid: number) => boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "capture-store-test-"));
  roots.push(root);
  const store = new FilesystemSkillCaptureStore({
    temporaryDirectory: root,
    processId: options.processId ?? 1234,
    processIsAlive: options.processIsAlive ?? (() => false),
    userId,
    now: () => new Date("2026-08-21T12:34:56.000Z"),
  });
  return { root, store };
}

async function createCandidate(
  root: string,
  name: string,
  marker: unknown,
): Promise<string> {
  const candidate = path.join(root, name);
  await mkdir(candidate, { mode: 0o700 });
  await chmod(candidate, 0o700);
  await writeFile(
    path.join(candidate, ".capture-owner.json"),
    `${JSON.stringify(marker)}\n`,
    { mode: 0o600 },
  );
  await chmod(path.join(candidate, ".capture-owner.json"), 0o600);
  return candidate;
}

const marker = (pid: number) => ({
  formatVersion: 1,
  pid,
  createdAt: "2026-08-21T12:34:56.000Z",
});

describe.runIf(userId !== undefined)("FilesystemSkillCaptureStore", () => {
  it("uses the operating-system temporary directory by default", async () => {
    const store = new FilesystemSkillCaptureStore();
    const workspace = await store.createWorkspace();
    try {
      expect(path.dirname(workspace.id)).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(workspace.id)).toMatch(
        /^happy-machine-create-skill-.+/,
      );
    } finally {
      await store.cleanup(workspace);
    }
  });

  it("creates a private workspace and atomically publishes private artifacts", async () => {
    const { store } = await fixture();
    const workspace = await store.createWorkspace();
    const demonstration = await store.writeDemonstration(
      workspace,
      "# Demonstration\nprivate raw content\n",
    );
    const context = await store.writeSkillContext(
      workspace,
      "# Skill context\nfocused content\n",
    );

    expect((await lstat(workspace.id)).mode & 0o777).toBe(0o700);
    expect(
      (await lstat(path.join(workspace.id, ".capture-owner.json"))).mode &
        0o777,
    ).toBe(0o600);
    expect((await lstat(demonstration.id)).mode & 0o777).toBe(0o600);
    expect((await lstat(context.id)).mode & 0o777).toBe(0o600);
    expect(demonstration.agentReference).toBe(demonstration.id);
    expect(context.agentReference).toBe(context.id);
    expect(await readFile(demonstration.id, "utf8")).toContain(
      "private raw content",
    );
    expect(await readFile(context.id, "utf8")).toContain("focused content");
    expect((await readdir(workspace.id)).sort()).toEqual([
      ".capture-owner.json",
      "demonstration.md",
      "skill-context.md",
    ]);
    expect(
      JSON.parse(
        await readFile(path.join(workspace.id, ".capture-owner.json"), "utf8"),
      ),
    ).toEqual(marker(1234));
  });

  it("replaces an artifact through a sibling write without leaving temporary files", async () => {
    const { store } = await fixture();
    const workspace = await store.createWorkspace();
    const first = await store.writeDemonstration(workspace, "first");
    const second = await store.writeDemonstration(workspace, "second");

    expect(second).toEqual(first);
    expect(await readFile(second.id, "utf8")).toBe("second");
    expect((await readdir(workspace.id)).sort()).toEqual([
      ".capture-owner.json",
      "demonstration.md",
    ]);
  });

  it("removes an artifact and workspace idempotently", async () => {
    const { store } = await fixture();
    const workspace = await store.createWorkspace();
    const artifact = await store.writeDemonstration(workspace, "raw");

    await store.removeArtifact(artifact);
    await store.removeArtifact(artifact);
    await expect(lstat(artifact.id)).rejects.toMatchObject({ code: "ENOENT" });

    await store.cleanup(workspace);
    await store.cleanup(workspace);
    await expect(lstat(workspace.id)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes only abandoned workspaces with a valid owned marker", async () => {
    const alive = 2222;
    const dead = 3333;
    const { root, store } = await fixture({
      processIsAlive: (pid) => pid === alive,
    });
    const abandoned = await createCandidate(
      root,
      "happy-machine-create-skill-abandoned",
      marker(dead),
    );
    const live = await createCandidate(
      root,
      "happy-machine-create-skill-live",
      marker(alive),
    );
    const malformed = await createCandidate(
      root,
      "happy-machine-create-skill-malformed",
      { formatVersion: 1, pid: "not-a-pid", createdAt: "yesterday" },
    );
    const permissive = await createCandidate(
      root,
      "happy-machine-create-skill-permissive",
      marker(dead),
    );
    await chmod(path.join(permissive, ".capture-owner.json"), 0o644);
    const unrelated = await createCandidate(
      root,
      "other-application-workspace",
      marker(dead),
    );
    const target = await createCandidate(root, "symlink-target", marker(dead));
    const linked = path.join(root, "happy-machine-create-skill-linked");
    await symlink(target, linked, "dir");

    await store.cleanupAbandoned();
    await store.cleanupAbandoned();

    await expect(lstat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(live)).resolves.toBeDefined();
    await expect(lstat(malformed)).resolves.toBeDefined();
    await expect(lstat(permissive)).resolves.toBeDefined();
    await expect(lstat(unrelated)).resolves.toBeDefined();
    await expect(lstat(linked)).resolves.toMatchObject({});
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    await expect(lstat(target)).resolves.toBeDefined();
  });

  it("does not remove a workspace whose marker is a symlink", async () => {
    const { root, store } = await fixture();
    const markerSource = path.join(root, "marker-source.json");
    await writeFile(markerSource, JSON.stringify(marker(3333)), {
      mode: 0o600,
    });
    const candidate = path.join(root, "happy-machine-create-skill-marker-link");
    await mkdir(candidate, { mode: 0o700 });
    await symlink(markerSource, path.join(candidate, ".capture-owner.json"));

    await store.cleanupAbandoned();

    expect((await lstat(candidate)).isDirectory()).toBe(true);
  });

  it("does not remove a workspace that is not owned by the current user", async () => {
    const { root } = await fixture();
    const candidate = await createCandidate(
      root,
      "happy-machine-create-skill-other-owner",
      marker(3333),
    );
    const store = new FilesystemSkillCaptureStore({
      temporaryDirectory: root,
      processIsAlive: () => false,
      userId: userId! + 1,
    });

    await store.cleanupAbandoned();

    expect((await lstat(candidate)).isDirectory()).toBe(true);
  });

  it("reports a failed cleanup with the private workspace path and leaves it intact", async () => {
    const { root, store } = await fixture();
    const workspace = await store.createWorkspace();
    const original = `${workspace.id}-original`;
    await rename(workspace.id, original);
    await symlink(original, workspace.id, "dir");

    let failure: unknown;
    try {
      await store.cleanup(workspace);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(FilesystemSkillCaptureCleanupError);
    expect(failure).toMatchObject({
      remainingWorkspacePath: workspace.id,
    });
    expect((failure as Error).message).toContain(workspace.id);
    expect((await lstat(workspace.id)).isSymbolicLink()).toBe(true);
    expect((await lstat(original)).isDirectory()).toBe(true);

    await rm(workspace.id);
    await rename(original, workspace.id);
    await store.cleanup(workspace);
    await expect(lstat(workspace.id)).rejects.toMatchObject({ code: "ENOENT" });
    expect(path.dirname(workspace.id)).toBe(root);
  });

  it("never writes captured content to diagnostic output", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { store } = await fixture();
    const workspace = await store.createWorkspace();

    await store.writeDemonstration(workspace, "highly-sensitive-capture");
    await store.cleanup(workspace);

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
