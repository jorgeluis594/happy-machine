import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ExclusiveOperationAlreadyActiveError,
  type ExclusiveOperationLock,
  type ExclusiveOperationName,
  type OperationLease,
} from "../../../../ports/exclusive-operation-lock.js";

const lockFormatVersion = 1;
const lockFilename = "happy-machine-create-skill.lock";
const reclaimFilename = `${lockFilename}.reclaim`;
const maximumAcquireAttempts = 8;

interface LockOwner {
  formatVersion: number;
  operation: ExclusiveOperationName;
  leaseId: string;
  pid: number;
  createdAt: string;
}

export interface FilesystemExclusiveOperationLockOptions {
  temporaryDirectory?: string;
  processId?: number;
  now?: () => Date;
  randomId?: () => string;
  processIsAlive?: (pid: number) => boolean;
  userId?: number;
}

export class FilesystemExclusiveOperationLock implements ExclusiveOperationLock {
  private readonly lockPath: string;
  private readonly reclaimPath: string;
  private readonly processId: number;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly processIsAlive: (pid: number) => boolean;
  private readonly userId: number | undefined;

  constructor(options: FilesystemExclusiveOperationLockOptions = {}) {
    const temporaryDirectory = path.resolve(
      options.temporaryDirectory ?? os.tmpdir(),
    );
    this.lockPath = path.join(temporaryDirectory, lockFilename);
    this.reclaimPath = path.join(temporaryDirectory, reclaimFilename);
    this.processId = options.processId ?? process.pid;
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    this.processIsAlive = options.processIsAlive ?? processIsAlive;
    this.userId = options.userId ?? process.getuid?.();
  }

  async acquire(name: ExclusiveOperationName): Promise<OperationLease> {
    if (name !== "create-skill") throw new Error("Unsupported operation name");

    const owner = this.createOwner(name);
    for (let attempt = 0; attempt < maximumAcquireAttempts; attempt += 1) {
      await this.rejectOrRemoveAbandonedReclaimer(name);

      try {
        await this.createOwnerFile(this.lockPath, owner);
        return { id: owner.leaseId };
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }

      const existingOwner = await this.readValidOwner(this.lockPath);
      if (existingOwner === undefined || this.processIsAlive(existingOwner.pid))
        throw new ExclusiveOperationAlreadyActiveError(name);

      const reclaimed = await this.replaceStaleOwner(existingOwner, owner);
      if (reclaimed) return { id: owner.leaseId };
    }

    throw new ExclusiveOperationAlreadyActiveError(name);
  }

  async release(lease: OperationLease): Promise<void> {
    const owner = await this.readValidOwner(this.lockPath);
    if (owner === undefined || owner.leaseId !== lease.id) return;

    const confirmedOwner = await this.readValidOwner(this.lockPath);
    if (confirmedOwner?.leaseId !== lease.id) return;

    try {
      await rm(this.lockPath, { force: false });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  private createOwner(operation: ExclusiveOperationName): LockOwner {
    return {
      formatVersion: lockFormatVersion,
      operation,
      leaseId: this.randomId(),
      pid: this.processId,
      createdAt: this.now().toISOString(),
    };
  }

  private async replaceStaleOwner(
    expectedOwner: LockOwner,
    newOwner: LockOwner,
  ): Promise<boolean> {
    const reclaimer = this.createOwner("create-skill");
    try {
      await this.createOwnerFile(this.reclaimPath, reclaimer);
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }

    try {
      const currentOwner = await this.readValidOwner(this.lockPath);
      if (
        currentOwner === undefined ||
        currentOwner.leaseId !== expectedOwner.leaseId ||
        this.processIsAlive(currentOwner.pid)
      )
        return false;

      await rm(this.lockPath, { force: false });
      try {
        await this.createOwnerFile(this.lockPath, newOwner);
        return true;
      } catch (error) {
        if (errorCode(error) === "EEXIST") return false;
        throw error;
      }
    } finally {
      await this.removeOwnedFile(this.reclaimPath, reclaimer.leaseId);
    }
  }

  private async rejectOrRemoveAbandonedReclaimer(
    operation: ExclusiveOperationName,
  ): Promise<void> {
    const reclaimer = await this.readValidOwner(this.reclaimPath);
    if (reclaimer === undefined) {
      if (await exists(this.reclaimPath))
        throw new ExclusiveOperationAlreadyActiveError(operation);
      return;
    }
    if (this.processIsAlive(reclaimer.pid))
      throw new ExclusiveOperationAlreadyActiveError(operation);
    await this.removeOwnedFile(this.reclaimPath, reclaimer.leaseId);
  }

  private async createOwnerFile(
    target: string,
    owner: LockOwner,
  ): Promise<void> {
    await writeFile(target, `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(target, 0o600);
  }

  private async removeOwnedFile(
    target: string,
    expectedLeaseId: string,
  ): Promise<void> {
    const owner = await this.readValidOwner(target);
    if (owner?.leaseId !== expectedLeaseId) return;
    try {
      await rm(target, { force: false });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  private async readValidOwner(target: string): Promise<LockOwner | undefined> {
    try {
      const entry = await lstat(target);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        (entry.mode & 0o777) !== 0o600 ||
        !this.isCurrentOwner(entry.uid)
      )
        return;

      const value: unknown = JSON.parse(await readFile(target, "utf8"));
      if (!isRecord(value)) return;
      const keys = Object.keys(value).sort();
      if (
        keys.length !== 5 ||
        keys[0] !== "createdAt" ||
        keys[1] !== "formatVersion" ||
        keys[2] !== "leaseId" ||
        keys[3] !== "operation" ||
        keys[4] !== "pid" ||
        value.formatVersion !== lockFormatVersion ||
        value.operation !== "create-skill" ||
        typeof value.leaseId !== "string" ||
        value.leaseId.length === 0 ||
        !Number.isSafeInteger(value.pid) ||
        (value.pid as number) <= 0 ||
        typeof value.createdAt !== "string" ||
        !isCanonicalIsoDate(value.createdAt)
      )
        return;
      return value as unknown as LockOwner;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      return;
    }
  }

  private isCurrentOwner(ownerId: number): boolean {
    return this.userId !== undefined && ownerId === this.userId;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalIsoDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}
