import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FilesystemExclusiveOperationLock,
  type FilesystemExclusiveOperationLockOptions,
} from "../src/infrastructure/outbound/exclusive-operation-lock/filesystem/filesystem-exclusive-operation-lock.js";
import { ExclusiveOperationAlreadyActiveError } from "../src/ports/exclusive-operation-lock.js";

const roots: string[] = [];
const userId = process.getuid?.();
const lockFilename = "happy-machine-create-skill.lock";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  options: Omit<
    FilesystemExclusiveOperationLockOptions,
    "temporaryDirectory" | "userId"
  > = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "exclusive-lock-test-"));
  roots.push(root);
  let nextId = 0;
  const lock = new FilesystemExclusiveOperationLock({
    temporaryDirectory: root,
    processId: 1234,
    processIsAlive: () => false,
    userId,
    now: () => new Date("2026-08-21T12:34:56.000Z"),
    randomId: () => `lease-${++nextId}`,
    ...options,
  });
  return { root, lock, lockPath: path.join(root, lockFilename) };
}

function owner(pid: number, leaseId: string) {
  return {
    formatVersion: 1,
    operation: "create-skill",
    leaseId,
    pid,
    createdAt: "2026-08-21T12:34:56.000Z",
  };
}

describe.runIf(userId !== undefined)("FilesystemExclusiveOperationLock", () => {
  it("allows only one of two simultaneous acquisitions", async () => {
    const { lock, lockPath } = await fixture({
      processIsAlive: (pid) => pid === 1234,
    });

    const results = await Promise.allSettled([
      lock.acquire("create-skill"),
      lock.acquire("create-skill"),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.some(
        (result) =>
          result.status === "rejected" &&
          (result.reason as unknown) instanceof
            ExclusiveOperationAlreadyActiveError,
      ),
    ).toBe(true);
    expect((await lstat(lockPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects a verified live owner with a technology-neutral busy error", async () => {
    const livePid = 4321;
    const { root, lock, lockPath } = await fixture({
      processIsAlive: (pid) => pid === livePid,
    });
    await writeFile(lockPath, `${JSON.stringify(owner(livePid, "live"))}\n`, {
      mode: 0o600,
    });
    await chmod(lockPath, 0o600);

    await expect(lock.acquire("create-skill")).rejects.toMatchObject({
      name: "ExclusiveOperationAlreadyActiveError",
      operation: "create-skill",
    });
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(
      owner(livePid, "live"),
    );
    expect(await lstat(root)).toBeDefined();
  });

  it("replaces a stale owner only after verifying that its PID is dead", async () => {
    const stalePid = 4321;
    const { root, lock, lockPath } = await fixture({
      processIsAlive: (pid) => pid !== stalePid,
    });
    await writeFile(
      lockPath,
      `${JSON.stringify(owner(stalePid, "stale-lease"))}\n`,
      { mode: 0o600 },
    );
    await chmod(lockPath, 0o600);

    const lease = await lock.acquire("create-skill");
    const metadata = JSON.parse(await readFile(lockPath, "utf8")) as unknown;

    expect(lease.id).not.toBe("stale-lease");
    expect(metadata).toMatchObject({
      operation: "create-skill",
      leaseId: lease.id,
      pid: 1234,
    });
    await expect(
      lstat(path.join(root, `${lockFilename}.reclaim`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows only one simultaneous stale-owner replacement", async () => {
    const stalePid = 4321;
    const { lock, lockPath } = await fixture({
      processIsAlive: (pid) => pid === 1234,
    });
    await writeFile(
      lockPath,
      `${JSON.stringify(owner(stalePid, "stale-lease"))}\n`,
      { mode: 0o600 },
    );
    await chmod(lockPath, 0o600);

    const results = await Promise.allSettled([
      lock.acquire("create-skill"),
      lock.acquire("create-skill"),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  it("does not let a previous lease release a newer owner's lock", async () => {
    const { lock, lockPath } = await fixture();
    const previousLease = await lock.acquire("create-skill");
    await rm(lockPath);
    await writeFile(
      lockPath,
      `${JSON.stringify(owner(9876, "newer-lease"))}\n`,
      { mode: 0o600 },
    );
    await chmod(lockPath, 0o600);

    await lock.release(previousLease);

    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(
      owner(9876, "newer-lease"),
    );
  });

  it("releases its own lease idempotently and leaves unrelated files untouched", async () => {
    const { root, lock, lockPath } = await fixture();
    const unrelated = path.join(root, "unrelated.txt");
    await writeFile(unrelated, "keep me");
    const lease = await lock.acquire("create-skill");

    await lock.release(lease);
    await lock.release(lease);

    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(unrelated, "utf8")).toBe("keep me");
  });

  it("does not replace malformed, permissive, or symlink lock files", async () => {
    const malformedFixture = await fixture();
    await writeFile(malformedFixture.lockPath, "not-json", { mode: 0o600 });
    await expect(
      malformedFixture.lock.acquire("create-skill"),
    ).rejects.toBeInstanceOf(ExclusiveOperationAlreadyActiveError);
    expect(await readFile(malformedFixture.lockPath, "utf8")).toBe("not-json");

    const permissiveFixture = await fixture();
    await writeFile(
      permissiveFixture.lockPath,
      `${JSON.stringify(owner(4321, "permissive"))}\n`,
      { mode: 0o644 },
    );
    await chmod(permissiveFixture.lockPath, 0o644);
    await expect(
      permissiveFixture.lock.acquire("create-skill"),
    ).rejects.toBeInstanceOf(ExclusiveOperationAlreadyActiveError);

    const symlinkFixture = await fixture();
    const target = path.join(symlinkFixture.root, "target.json");
    await writeFile(target, `${JSON.stringify(owner(4321, "linked"))}\n`, {
      mode: 0o600,
    });
    await symlink(target, symlinkFixture.lockPath);
    await expect(
      symlinkFixture.lock.acquire("create-skill"),
    ).rejects.toBeInstanceOf(ExclusiveOperationAlreadyActiveError);
    expect((await lstat(symlinkFixture.lockPath)).isSymbolicLink()).toBe(true);
  });
});
