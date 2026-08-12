import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ManagedWorktreeRecord } from "../../../../domain/execution/run.js";
import type {
  EnsureChildWorkspaceRequest,
  EnsureMainWorkspaceRequest,
  ProjectWorkspaces,
  WorktreeObservation,
} from "../../../../ports/project-workspaces.js";
import { ProjectWorkspaceError } from "../../../../ports/project-workspaces.js";

const executeFile = promisify(execFile);

interface WorktreeRegistration {
  path: string;
  head?: string;
  branch?: string;
}

export class GitProjectWorkspaces implements ProjectWorkspaces {
  async ensureMain(
    request: EnsureMainWorkspaceRequest,
  ): Promise<ManagedWorktreeRecord> {
    const run = this.component(request.runId);
    const managedPath = path.join(
      request.projectRoot,
      ".happy-machine",
      "worktrees",
      run,
      "main",
    );
    const branch = `happy-machine/${run}/main`;
    const existing = await this.existing(
      request.projectRoot,
      managedPath,
      branch,
    );
    if (existing)
      return this.record("main", "main", managedPath, branch, existing.head);

    const startingHead = await this.commit(request.projectRoot, "HEAD");
    await this.create(request.projectRoot, managedPath, branch, startingHead);
    return this.record("main", "main", managedPath, branch, startingHead);
  }

  async ensureChild(
    request: EnsureChildWorkspaceRequest,
  ): Promise<ManagedWorktreeRecord> {
    const run = this.component(request.runId);
    const state = this.component(request.stateId);
    const task = this.component(request.taskId);
    const managedPath = path.join(
      request.projectRoot,
      ".happy-machine",
      "worktrees",
      run,
      "states",
      state,
      "visits",
      String(request.visitNumber),
      "tasks",
      task,
    );
    const branch = `happy-machine/${run}/states/${state}/visits/${request.visitNumber}/tasks/${task}`;
    const startingHead = await this.commit(
      request.projectRoot,
      request.startingHead,
    );
    const existing = await this.existing(
      request.projectRoot,
      managedPath,
      branch,
    );
    if (existing) {
      if (existing.head !== startingHead)
        throw new ProjectWorkspaceError(
          `Managed child worktree has unexpected HEAD: ${managedPath}`,
        );
    } else
      await this.create(request.projectRoot, managedPath, branch, startingHead);
    return this.record(
      `parallel:${request.stateId}:${request.visitNumber}:${request.taskId}`,
      "parallel_task",
      managedPath,
      branch,
      startingHead,
      {
        stateId: request.stateId,
        visitNumber: request.visitNumber,
        taskId: request.taskId,
      },
    );
  }

  async observe(worktree: ManagedWorktreeRecord): Promise<WorktreeObservation> {
    try {
      const endingHead = await this.commit(worktree.path, "HEAD");
      const { stdout } = await executeFile(
        "git",
        [
          "-C",
          worktree.path,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ],
        { maxBuffer: 10 * 1024 * 1024 },
      );
      return { endingHead, dirty: stdout.length > 0 };
    } catch (error) {
      throw this.failure("observe managed worktree", error);
    }
  }

  private record(
    id: string,
    role: ManagedWorktreeRecord["role"],
    managedPath: string,
    branch: string,
    startingHead: string,
    provenance?: ManagedWorktreeRecord["provenance"],
  ): ManagedWorktreeRecord {
    return {
      id,
      role,
      ...(provenance ? { provenance } : {}),
      path: managedPath,
      branch,
      startingHead,
      endingHead: startingHead,
      dirty: false,
    };
  }

  private async create(
    projectRoot: string,
    managedPath: string,
    branch: string,
    startingHead: string,
  ): Promise<void> {
    try {
      const branchExists = await this.branchExists(projectRoot, branch);
      if (branchExists)
        throw new ProjectWorkspaceError(
          `Managed worktree branch already exists without its registered path: ${branch}`,
        );
      await mkdir(path.dirname(managedPath), { recursive: true });
      await executeFile(
        "git",
        [
          "-C",
          projectRoot,
          "worktree",
          "add",
          "-b",
          branch,
          managedPath,
          startingHead,
        ],
        { maxBuffer: 10 * 1024 * 1024 },
      );
    } catch (error) {
      if (error instanceof ProjectWorkspaceError) throw error;
      throw this.failure("create managed worktree", error);
    }
  }

  private async existing(
    projectRoot: string,
    managedPath: string,
    branch: string,
  ): Promise<Required<WorktreeRegistration> | undefined> {
    let registrations: WorktreeRegistration[];
    try {
      const { stdout } = await executeFile(
        "git",
        ["-C", projectRoot, "worktree", "list", "--porcelain"],
        { maxBuffer: 10 * 1024 * 1024 },
      );
      registrations = this.registrations(stdout);
    } catch (error) {
      throw this.failure("inspect managed worktree registrations", error);
    }
    const expectedPath = await this.canonicalPath(managedPath);
    let registered: WorktreeRegistration | undefined;
    for (const candidate of registrations)
      if ((await this.canonicalPath(candidate.path)) === expectedPath) {
        registered = candidate;
        break;
      }
    const branchRegistration = registrations.find(
      (candidate) => candidate.branch === `refs/heads/${branch}`,
    );
    if (!registered) {
      if (branchRegistration)
        throw new ProjectWorkspaceError(
          `Managed worktree branch is registered at another path: ${branch}`,
        );
      return undefined;
    }
    if (registered.branch !== `refs/heads/${branch}`)
      throw new ProjectWorkspaceError(
        `Managed worktree path uses an unexpected branch: ${managedPath}`,
      );
    try {
      if ((await realpath(managedPath)) !== (await realpath(registered.path)))
        throw new Error("real path mismatch");
      const actualBranch = await this.output(managedPath, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      if (actualBranch !== branch)
        throw new Error(`expected branch ${branch}, found ${actualBranch}`);
      const head = await this.commit(managedPath, "HEAD");
      return { path: registered.path, branch: registered.branch, head };
    } catch (error) {
      throw this.failure("validate managed worktree", error);
    }
  }

  private registrations(output: string): WorktreeRegistration[] {
    return output
      .trim()
      .split(/\n\n+/)
      .filter(Boolean)
      .map((block) => {
        const values = new Map<string, string>();
        for (const line of block.split("\n")) {
          const separator = line.indexOf(" ");
          if (separator === -1) continue;
          values.set(line.slice(0, separator), line.slice(separator + 1));
        }
        const worktreePath = values.get("worktree");
        if (!worktreePath)
          throw new ProjectWorkspaceError(
            "Git returned a worktree registration without a path",
          );
        return {
          path: worktreePath,
          ...(values.has("HEAD") ? { head: values.get("HEAD") } : {}),
          ...(values.has("branch") ? { branch: values.get("branch") } : {}),
        };
      });
  }

  private async branchExists(
    projectRoot: string,
    branch: string,
  ): Promise<boolean> {
    try {
      await executeFile("git", [
        "-C",
        projectRoot,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 1
      )
        return false;
      throw error;
    }
  }

  private async commit(directory: string, revision: string): Promise<string> {
    try {
      return await this.output(directory, [
        "rev-parse",
        "--verify",
        `${revision}^{commit}`,
      ]);
    } catch (error) {
      throw this.failure("resolve Git commit", error);
    }
  }

  private async output(directory: string, args: string[]): Promise<string> {
    const { stdout } = await executeFile("git", ["-C", directory, ...args], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  }

  private async canonicalPath(candidate: string): Promise<string> {
    try {
      return await realpath(candidate);
    } catch {
      return path.resolve(candidate);
    }
  }

  private component(value: string): string {
    let component = "";
    for (const character of value)
      component += /^[A-Za-z0-9_-]$/.test(character)
        ? character
        : `_${character.codePointAt(0)!.toString(16)}_`;
    if (component.length <= 80) return component;
    const digest = createHash("sha256")
      .update(value)
      .digest("hex")
      .slice(0, 16);
    return `${component.slice(0, 63)}-${digest}`;
  }

  private failure(operation: string, error: unknown): ProjectWorkspaceError {
    const detail =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr).trim()
        : error instanceof Error
          ? error.message
          : String(error);
    return new ProjectWorkspaceError(
      `${operation} failed${detail ? `: ${detail}` : ""}`,
    );
  }
}
