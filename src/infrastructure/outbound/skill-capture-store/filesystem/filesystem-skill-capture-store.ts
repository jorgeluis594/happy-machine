import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CaptureArtifact,
  CaptureWorkspace,
  SkillCaptureStore,
} from "../../../../ports/skill-capture-store.js";

const workspacePrefix = "happy-machine-create-skill-";
const ownerFilename = ".capture-owner.json";
const artifactFilenames = new Set(["demonstration.md", "skill-context.md"]);
const ownerFormatVersion = 1;

interface CaptureOwnerMarker {
  formatVersion: number;
  pid: number;
  createdAt: string;
}

export interface FilesystemSkillCaptureStoreOptions {
  temporaryDirectory?: string;
  processId?: number;
  now?: () => Date;
  processIsAlive?: (pid: number) => boolean;
  userId?: number;
}

export class FilesystemSkillCaptureCleanupError extends Error {
  override readonly name = "FilesystemSkillCaptureCleanupError";

  constructor(
    readonly remainingWorkspacePath: string,
    options: ErrorOptions = {},
  ) {
    super(
      `Private capture workspace could not be completely removed: ${remainingWorkspacePath}`,
      options,
    );
  }
}

export class FilesystemSkillCaptureStore implements SkillCaptureStore {
  private readonly temporaryDirectory: string;
  private readonly processId: number;
  private readonly now: () => Date;
  private readonly processIsAlive: (pid: number) => boolean;
  private readonly userId: number | undefined;

  constructor(options: FilesystemSkillCaptureStoreOptions = {}) {
    this.temporaryDirectory = path.resolve(
      options.temporaryDirectory ?? os.tmpdir(),
    );
    this.processId = options.processId ?? process.pid;
    this.now = options.now ?? (() => new Date());
    this.processIsAlive = options.processIsAlive ?? processIsAlive;
    this.userId = options.userId ?? process.getuid?.();
  }

  async cleanupAbandoned(): Promise<void> {
    const entries = await readdir(this.temporaryDirectory, {
      withFileTypes: true,
      encoding: "utf8",
    });
    const failures: FilesystemSkillCaptureCleanupError[] = [];

    for (const entry of entries) {
      if (!this.isWorkspaceName(entry.name)) continue;
      const workspacePath = path.join(this.temporaryDirectory, entry.name);
      if (!(await this.isAbandonedWorkspace(workspacePath))) continue;

      try {
        await rm(workspacePath, { recursive: true, force: false });
        if (await exists(workspacePath))
          throw new Error("workspace still exists after removal");
      } catch (error) {
        if (await exists(workspacePath))
          failures.push(
            new FilesystemSkillCaptureCleanupError(workspacePath, {
              cause: error,
            }),
          );
      }
    }

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Private capture workspaces could not be completely removed",
      );
  }

  async createWorkspace(): Promise<CaptureWorkspace> {
    const workspacePath = await mkdtemp(
      path.join(this.temporaryDirectory, workspacePrefix),
    );
    try {
      await chmod(workspacePath, 0o700);
      const marker: CaptureOwnerMarker = {
        formatVersion: ownerFormatVersion,
        pid: this.processId,
        createdAt: this.now().toISOString(),
      };
      await this.atomicWrite(
        path.join(workspacePath, ownerFilename),
        `${JSON.stringify(marker)}\n`,
      );
      return { id: workspacePath };
    } catch (error) {
      try {
        await rm(workspacePath, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new FilesystemSkillCaptureCleanupError(workspacePath, {
          cause: new AggregateError(
            [error, cleanupError],
            "Capture workspace creation and rollback failed",
          ),
        });
      }
      throw error;
    }
  }

  async writeDemonstration(
    workspace: CaptureWorkspace,
    markdown: string,
  ): Promise<CaptureArtifact> {
    return this.writeArtifact(workspace, "demonstration.md", markdown);
  }

  async writeSkillContext(
    workspace: CaptureWorkspace,
    markdown: string,
  ): Promise<CaptureArtifact> {
    return this.writeArtifact(workspace, "skill-context.md", markdown);
  }

  async removeArtifact(artifact: CaptureArtifact): Promise<void> {
    const artifactPath = this.requireArtifactPath(artifact);
    let entry;
    try {
      entry = await lstat(artifactPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error("Capture artifact is not a regular file");
    if (
      !(await this.isOwnedWorkspace(path.dirname(artifactPath), this.processId))
    )
      throw new Error("Capture workspace ownership could not be validated");
    await rm(artifactPath, { force: true });
  }

  async cleanup(workspace: CaptureWorkspace): Promise<void> {
    const workspacePath = this.requireWorkspacePath(workspace);
    try {
      const entry = await lstat(workspacePath);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error("Capture workspace is not a regular directory");
      if (!(await this.isOwnedWorkspace(workspacePath, this.processId)))
        throw new Error("Capture workspace ownership could not be validated");
      await rm(workspacePath, { recursive: true, force: false });
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      if (!(await exists(workspacePath))) return;
      throw new FilesystemSkillCaptureCleanupError(workspacePath, {
        cause: error,
      });
    }

    if (await exists(workspacePath))
      throw new FilesystemSkillCaptureCleanupError(workspacePath, {
        cause: new Error("workspace still exists after removal"),
      });
  }

  private async writeArtifact(
    workspace: CaptureWorkspace,
    filename: "demonstration.md" | "skill-context.md",
    markdown: string,
  ): Promise<CaptureArtifact> {
    const workspacePath = this.requireWorkspacePath(workspace);
    if (!(await this.isOwnedWorkspace(workspacePath, this.processId)))
      throw new Error("Capture workspace ownership could not be validated");
    const artifactPath = path.join(workspacePath, filename);
    await this.atomicWrite(artifactPath, markdown);
    return { id: artifactPath, agentReference: artifactPath };
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const temporary = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${randomUUID()}.tmp`,
    );
    let writeError: unknown;
    try {
      await writeFile(temporary, content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
    } catch (error) {
      writeError = error;
    }

    try {
      await rm(temporary, { force: true });
    } catch (cleanupError) {
      throw new FilesystemSkillCaptureCleanupError(path.dirname(target), {
        cause:
          writeError === undefined
            ? cleanupError
            : new AggregateError(
                [writeError, cleanupError],
                "Atomic capture write and temporary-file cleanup failed",
              ),
      });
    }
    if (writeError instanceof Error) throw writeError;
    if (writeError !== undefined)
      throw new Error("Atomic capture write failed", { cause: writeError });
  }

  private requireWorkspacePath(workspace: CaptureWorkspace): string {
    const workspacePath = path.resolve(workspace.id);
    if (
      workspacePath !== workspace.id ||
      path.dirname(workspacePath) !== this.temporaryDirectory ||
      !this.isWorkspaceName(path.basename(workspacePath))
    )
      throw new Error("Invalid capture workspace reference");
    return workspacePath;
  }

  private requireArtifactPath(artifact: CaptureArtifact): string {
    const artifactPath = path.resolve(artifact.id);
    if (
      artifactPath !== artifact.id ||
      artifact.agentReference !== artifactPath ||
      !artifactFilenames.has(path.basename(artifactPath)) ||
      path.dirname(path.dirname(artifactPath)) !== this.temporaryDirectory ||
      !this.isWorkspaceName(path.basename(path.dirname(artifactPath)))
    )
      throw new Error("Invalid capture artifact reference");
    return artifactPath;
  }

  private isWorkspaceName(name: string): boolean {
    return (
      name.startsWith(workspacePrefix) && name.length > workspacePrefix.length
    );
  }

  private async isAbandonedWorkspace(workspacePath: string): Promise<boolean> {
    const marker = await this.readValidMarker(workspacePath);
    return marker !== undefined && !this.processIsAlive(marker.pid);
  }

  private async isOwnedWorkspace(
    workspacePath: string,
    expectedPid?: number,
  ): Promise<boolean> {
    const marker = await this.readValidMarker(workspacePath);
    return (
      marker !== undefined &&
      (expectedPid === undefined || marker.pid === expectedPid)
    );
  }

  private async readValidMarker(
    workspacePath: string,
  ): Promise<CaptureOwnerMarker | undefined> {
    try {
      const directory = await lstat(workspacePath);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (directory.mode & 0o777) !== 0o700 ||
        !this.isCurrentOwner(directory.uid)
      )
        return;

      const markerPath = path.join(workspacePath, ownerFilename);
      const markerEntry = await lstat(markerPath);
      if (
        !markerEntry.isFile() ||
        markerEntry.isSymbolicLink() ||
        (markerEntry.mode & 0o777) !== 0o600 ||
        !this.isCurrentOwner(markerEntry.uid)
      )
        return;

      const value: unknown = JSON.parse(await readFile(markerPath, "utf8"));
      if (!isRecord(value)) return;
      const keys = Object.keys(value).sort();
      if (
        keys.length !== 3 ||
        keys[0] !== "createdAt" ||
        keys[1] !== "formatVersion" ||
        keys[2] !== "pid" ||
        value.formatVersion !== ownerFormatVersion ||
        !Number.isSafeInteger(value.pid) ||
        (value.pid as number) <= 0 ||
        typeof value.createdAt !== "string" ||
        !isCanonicalIsoDate(value.createdAt)
      )
        return;
      return value as unknown as CaptureOwnerMarker;
    } catch {
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
