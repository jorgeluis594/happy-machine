import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  ControllerLease,
  DocumentRecord,
  RunRecord,
  TaskRecord,
  VisitRecord,
} from "../../../../domain/execution/run.js";
import {
  acquireControllerLease,
  leaseIsValid,
  renewControllerLease,
  runIsTerminal,
} from "../../../../domain/execution/run.js";
import {
  ControllerLeaseLostError,
  ResultValidationError,
  RunAlreadyControlledError,
  RunCancellationRequestedError,
  RunNotResumableError,
} from "../../../../ports/run-repository.js";
import type {
  AttemptPaths,
  CancellationRequestResult,
  ControllerSession,
  RecoveredRun,
  RunRepository,
  SnapshotCreationRequest,
  SnapshotCreationResult,
  ValidatedNormalResult,
} from "../../../../ports/run-repository.js";

interface StoredArtifact {
  kind: string;
  logicalId: string;
  internalPath: string;
  sha256: string;
  originalName?: string;
  content: string;
}

export class FilesystemRunRepository implements RunRepository {
  private readonly saveQueues = new Map<string, Promise<void>>();

  async createSnapshot(
    request: SnapshotCreationRequest,
  ): Promise<SnapshotCreationResult> {
    const runDirectory = this.runDirectoryFor(
      request.projectRoot,
      request.runId,
    );
    const snapshotDirectory = path.join(runDirectory, "snapshot");
    await mkdir(runDirectory, { recursive: true });
    const stagingDirectory = await mkdtemp(
      path.join(runDirectory, ".snapshot-"),
    );
    let published = false;
    try {
      const artifacts = this.artifacts(request);
      for (const artifact of artifacts)
        await this.writeExclusive(
          stagingDirectory,
          artifact.internalPath,
          artifact.content,
        );

      const effectiveDefinition = this.canonical(
        request.source.effectiveDefinition,
      );
      const manifestArtifacts = artifacts.map((artifact) =>
        this.canonical({
          kind: artifact.kind,
          logicalId: artifact.logicalId,
          internalPath: artifact.internalPath,
          sha256: artifact.sha256,
          ...(artifact.originalName === undefined
            ? {}
            : { originalName: artifact.originalName }),
        }),
      );
      const payload = this.canonical({
        formatVersion: 1,
        workflowId: request.workflowId,
        effectiveDefinition,
        artifacts: manifestArtifacts,
      }) as Record<string, unknown>;
      const identity = `sha256:${this.sha256(JSON.stringify(payload))}`;
      const manifest = this.canonical({ ...payload, identity });
      await this.writeExclusive(
        stagingDirectory,
        "manifest.json",
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await rename(stagingDirectory, snapshotDirectory);
      published = true;

      const inputs = artifacts
        .filter((artifact) => artifact.kind === "input")
        .map((artifact) => ({
          id: artifact.logicalId,
          originalName: artifact.originalName!,
          internalPath: artifact.internalPath,
          durablePath: this.durablePath(
            snapshotDirectory,
            artifact.internalPath,
          ),
          sha256: artifact.sha256,
        }));
      return {
        record: {
          identity,
          directory: snapshotDirectory,
          manifestPath: path.join(snapshotDirectory, "manifest.json"),
          inputs,
        },
        definition: effectiveDefinition as SnapshotCreationResult["definition"],
      };
    } finally {
      if (!published)
        await rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  async load(projectRoot: string, runId: string): Promise<RecoveredRun> {
    const directory = this.runDirectoryFor(projectRoot, runId);
    let run: RunRecord;
    let definition: RecoveredRun["definition"];
    try {
      run = JSON.parse(
        await readFile(path.join(directory, "run.json"), "utf8"),
      ) as RunRecord;
      const manifest = JSON.parse(
        await readFile(
          path.join(directory, "snapshot", "manifest.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      definition = manifest.effectiveDefinition as RecoveredRun["definition"];
    } catch (error) {
      throw new Error(
        `Durable run storage is corrupt: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (
      run.id !== runId ||
      (await realpath(run.projectRoot)) !== (await realpath(projectRoot)) ||
      !definition ||
      typeof definition !== "object" ||
      definition.workflowId !== run.workflowId
    )
      throw new Error("Durable run storage is inconsistent");
    return { run, definition };
  }

  async discoverProjectRoot(currentDirectory: string): Promise<string> {
    let candidate = await realpath(currentDirectory);
    while (true) {
      if (
        (await this.exists(path.join(candidate, "happy-machine.yaml"))) ||
        (await this.exists(path.join(candidate, ".happy-machine")))
      )
        return candidate;
      const parent = path.dirname(candidate);
      if (parent === candidate)
        throw new Error("Happy Machine project not found");
      candidate = parent;
    }
  }

  async list(projectRoot: string): Promise<RunRecord[]> {
    const runsDirectory = path.join(projectRoot, ".happy-machine", "runs");
    const entries = await readdir(runsDirectory, {
      withFileTypes: true,
      encoding: "utf8",
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          this.load(projectRoot, entry.name).then(({ run }) => run),
        ),
    );
    return runs.sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        right.id.localeCompare(left.id),
    );
  }

  async acquireControl(
    projectRoot: string,
    runId: string,
    controllerId: string,
    observedAt: string,
  ): Promise<ControllerSession> {
    return this.withRunLock(projectRoot, runId, async () => {
      const recovered = await this.load(projectRoot, runId);
      if (
        recovered.run.status === "canceling" ||
        recovered.run.status === "canceled"
      )
        throw new RunCancellationRequestedError(recovered.run);
      if (recovered.run.status !== "running")
        throw new RunNotResumableError(
          `Run ${runId} is already ${recovered.run.status}`,
        );
      const current = recovered.run.controllerLease;
      if (
        leaseIsValid(current, observedAt) &&
        current?.controllerId !== controllerId
      )
        throw new RunAlreadyControlledError(
          `Run ${runId} is already controlled by ${current?.controllerId}`,
        );
      const lease = acquireControllerLease(
        current,
        controllerId,
        recovered.definition.policies.controllerLeaseMs,
        observedAt,
      );
      recovered.run.controllerLease = lease;
      recovered.run.controllerStatus = "attached";
      this.appendLeaseEvent(
        recovered.run,
        current ? "controller_lease_recovered" : "controller_lease_acquired",
        observedAt,
        lease,
      );
      await this.writeRun(recovered.run);
      return { run: recovered.run, fencingToken: lease.fencingToken };
    });
  }

  async requestCancellation(
    projectRoot: string,
    runId: string,
    controllerId: string,
    requestedAt: string,
  ): Promise<CancellationRequestResult> {
    return this.withRunLock(projectRoot, runId, async () => {
      const recovered = await this.load(projectRoot, runId);
      if (runIsTerminal(recovered.run.status))
        return { accepted: false, run: recovered.run };

      const previousStatus = recovered.run.status;
      const previousLease = recovered.run.controllerLease;
      const lease = acquireControllerLease(
        previousLease,
        controllerId,
        recovered.definition.policies.controllerLeaseMs,
        requestedAt,
      );
      recovered.run.controllerLease = lease;
      recovered.run.controllerStatus = "attached";
      if (previousStatus === "running") {
        recovered.run.status = "canceling";
        recovered.run.cancellation = { requestedAt };
        recovered.run.events.push({
          sequence: recovered.run.events.length + 1,
          type: "run_cancellation_requested",
          at: requestedAt,
          data: { previousStatus },
        });
        recovered.run.events.push({
          sequence: recovered.run.events.length + 1,
          type: "run_status_changed",
          at: requestedAt,
          data: { from: previousStatus, to: "canceling" },
        });
      }
      this.appendLeaseEvent(
        recovered.run,
        previousLease
          ? "controller_lease_recovered"
          : "controller_lease_acquired",
        requestedAt,
        lease,
      );
      await this.writeRun(recovered.run);
      return {
        accepted: true,
        run: recovered.run,
        fencingToken: lease.fencingToken,
      };
    });
  }

  async renewControl(
    run: RunRecord,
    controllerId: string,
    fencingToken: number,
    observedAt: string,
  ): Promise<ControllerSession> {
    return this.withRunLock(run.projectRoot, run.id, async () => {
      const current = (await this.load(run.projectRoot, run.id)).run;
      const lease = this.requireLease(current, controllerId, fencingToken);
      if (!leaseIsValid(lease, observedAt))
        throw new ControllerLeaseLostError(
          "Controller lease expired before it could be renewed",
        );
      current.controllerLease = renewControllerLease(lease, observedAt);
      this.appendLeaseEvent(
        current,
        "controller_lease_renewed",
        observedAt,
        current.controllerLease,
      );
      await this.writeRun(current);
      return { run: current, fencingToken };
    });
  }

  async saveControlled(
    run: RunRecord,
    controllerId: string,
    fencingToken: number,
  ): Promise<void> {
    await this.withRunLock(run.projectRoot, run.id, async () => {
      const current = (await this.load(run.projectRoot, run.id)).run;
      this.requireLease(current, controllerId, fencingToken);
      run.controllerLease = current.controllerLease;
      await this.writeRun(run);
    });
  }

  async releaseControl(
    run: RunRecord,
    controllerId: string,
    fencingToken: number,
    observedAt: string,
  ): Promise<RunRecord> {
    return this.withRunLock(run.projectRoot, run.id, async () => {
      const current = (await this.load(run.projectRoot, run.id)).run;
      const lease = this.requireLease(current, controllerId, fencingToken);
      current.controllerLease = undefined;
      current.controllerStatus = "detached";
      this.appendLeaseEvent(
        current,
        "controller_lease_released",
        observedAt,
        lease,
      );
      await this.writeRun(current);
      return current;
    });
  }

  save(run: RunRecord): Promise<void> {
    const snapshot = structuredClone(run);
    if (snapshot.controllerLease)
      return this.saveControlled(
        snapshot,
        snapshot.controllerLease.controllerId,
        snapshot.controllerLease.fencingToken,
      );
    const previous = this.saveQueues.get(run.id) ?? Promise.resolve();
    const save = previous
      .catch(() => undefined)
      .then(async () => {
        const directory = this.runDirectory(snapshot);
        await mkdir(directory, { recursive: true });
        const target = path.join(directory, "run.json");
        const temporary = `${target}.tmp`;
        await writeFile(
          temporary,
          `${JSON.stringify(snapshot, null, 2)}\n`,
          "utf8",
        );
        await rename(temporary, target);
      });
    this.saveQueues.set(run.id, save);
    const cleanup = () => {
      if (this.saveQueues.get(run.id) === save) this.saveQueues.delete(run.id);
    };
    void save.then(cleanup, cleanup);
    return save;
  }

  private async writeRun(run: RunRecord): Promise<void> {
    const directory = this.runDirectory(run);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, "run.json");
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  private async exists(candidate: string): Promise<boolean> {
    try {
      await access(candidate, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async withRunLock<T>(
    projectRoot: string,
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lock = path.join(
      this.runDirectoryFor(projectRoot, runId),
      ".control-lock",
    );
    for (let attempt = 0; ; attempt += 1) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          attempt >= 100
        )
          throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  private requireLease(
    run: RunRecord,
    controllerId: string,
    fencingToken: number,
  ): ControllerLease {
    const lease = run.controllerLease;
    if (
      !lease ||
      lease.controllerId !== controllerId ||
      lease.fencingToken !== fencingToken
    ) {
      if (run.status === "canceling" || run.status === "canceled")
        throw new RunCancellationRequestedError(run);
      throw new ControllerLeaseLostError("Controller fencing token is stale");
    }
    return lease;
  }

  private appendLeaseEvent(
    run: RunRecord,
    type: string,
    at: string,
    lease: ControllerLease,
  ): void {
    run.events.push({
      sequence: run.events.length + 1,
      type,
      at,
      data: {
        controllerId: lease.controllerId,
        fencingToken: lease.fencingToken,
        expiresAt: lease.expiresAt,
      },
    });
  }

  async prepareVisitContext(run: RunRecord): Promise<string> {
    const visit = run.visits.at(-1)!;
    const visitDirectory = path.join(
      this.runDirectory(run),
      "states",
      this.segment(visit.stateId),
      "visits",
      String(visit.number),
    );
    const contextPath = path.join(visitDirectory, "context.md");
    await mkdir(visitDirectory, { recursive: true });
    const inputIndex = run.definitionSnapshot.inputs.flatMap((input) => [
      `### ${input.id}`,
      "",
      `- Original name: ${JSON.stringify(input.originalName)}`,
      `- Stable path: ${JSON.stringify(input.internalPath)}`,
      `- Durable path: ${JSON.stringify(input.durablePath)}`,
      `- SHA-256: \`${input.sha256}\``,
      "",
    ]);
    const documentIndex = run.documents.flatMap((document) => [
      `### ${document.name}`,
      "",
      `- Producing state: ${JSON.stringify(document.stateId)}`,
      `- Visit: ${document.visitNumber}`,
      `- Task: ${JSON.stringify(document.taskId)}`,
      `- Provenance path: ${JSON.stringify(document.internalPath)}`,
      `- Durable path: ${JSON.stringify(document.durablePath)}`,
      `- SHA-256: \`${document.sha256}\``,
      "",
    ]);
    const parallelIndex = run.visits.flatMap((candidate) =>
      candidate.type !== "parallel" || candidate.outcome === undefined
        ? []
        : [
            `### ${candidate.stateId} visit ${candidate.number}`,
            "",
            `- Aggregate outcome: ${candidate.outcome}`,
            `- Transition target: ${candidate.target}`,
            "",
            ...candidate.tasks.flatMap((task) => {
              const finalAttempt = task.attempts.at(-1);
              return [
                `#### Task ${task.id}`,
                "",
                `- Status: ${task.status}`,
                `- Attempts: ${task.attempts.length}`,
                `- Final error: ${task.failure ? `${task.failure.code}: ${task.failure.message}` : "none"}`,
                `- Control workspaces: ${task.attempts.map((attempt) => JSON.stringify(attempt.controlWorkspace)).join(", ") || "none"}`,
                `- Result paths: ${task.attempts.map((attempt) => JSON.stringify(attempt.resultPath)).join(", ") || "none"}`,
                `- Executor references: ${finalAttempt?.executor ? JSON.stringify(finalAttempt.executor) : "none"}`,
                `- Project workspace: ${JSON.stringify(task.workspace.path)} (${task.workspace.mode})`,
                "",
              ];
            }),
          ],
    );
    const context = [
      "# Happy Machine Visit Context",
      "",
      `Run: ${run.id}`,
      `Workflow: ${run.workflowId}`,
      `State: ${visit.stateId}`,
      `Visit: ${visit.number}`,
      "",
      "## Input documents",
      "",
      ...(inputIndex.length
        ? inputIndex
        : ["No input documents were supplied for this run.", ""]),
      "## Workflow documents",
      "",
      ...(documentIndex.length
        ? documentIndex
        : ["No workflow documents have been committed yet.", ""]),
      "## Completed parallel states",
      "",
      ...(parallelIndex.length
        ? parallelIndex
        : ["No parallel state has completed yet.", ""]),
    ].join("\n");
    await writeFile(contextPath, context, { encoding: "utf8", flag: "wx" });
    return contextPath;
  }

  async prepareAttempt(
    run: RunRecord,
    visit: VisitRecord,
    task: TaskRecord,
    attemptNumber: number,
  ): Promise<AttemptPaths> {
    const controlWorkspace = path.join(
      this.runDirectory(run),
      "states",
      visit.stateId,
      "visits",
      String(visit.number),
      "tasks",
      this.segment(task.id),
      "attempts",
      String(attemptNumber),
    );
    const outputDirectory = path.join(controlWorkspace, "output");
    const contextPath = visit.contextPath;
    const resultPath = path.join(controlWorkspace, "result.json");
    await mkdir(outputDirectory, { recursive: true });
    return { controlWorkspace, contextPath, outputDirectory, resultPath };
  }

  async readResult(
    resultPath: string,
    outputDirectory: string,
    allowedOutcomes: readonly string[],
  ): Promise<ValidatedNormalResult> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(resultPath, "utf8"));
    } catch {
      throw new ResultValidationError(
        "result_missing_or_invalid",
        `Missing or invalid result.json: ${resultPath}`,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ResultValidationError(
        "result_missing_or_invalid",
        "result.json must contain an object",
      );
    const result = value as Record<string, unknown>;
    if (
      typeof result.outcome !== "string" ||
      !allowedOutcomes.includes(result.outcome)
    )
      throw new ResultValidationError(
        "outcome_invalid",
        "result.json contains an unknown outcome",
      );
    if (
      !Array.isArray(result.documents) ||
      result.documents.some((item) => typeof item !== "string")
    )
      throw new ResultValidationError(
        "documents_invalid",
        "result.json documents must be an array of paths",
      );
    await this.validateDocuments(outputDirectory, result.documents as string[]);
    if ("error" in result && !this.isJsonValue(result.error))
      throw new ResultValidationError(
        "result_missing_or_invalid",
        "result.json error must be serializable diagnostic data",
      );
    return {
      outcome: result.outcome,
      documents: result.documents as string[],
      ...(result.error === undefined ? {} : { error: result.error }),
    } as ValidatedNormalResult;
  }

  async stageDocuments(
    run: RunRecord,
    visit: VisitRecord,
    task: TaskRecord,
    outputDirectory: string,
    names: readonly string[],
  ): Promise<DocumentRecord[]> {
    const validated = await this.validateDocuments(outputDirectory, names);
    const records: DocumentRecord[] = [];
    const planned = validated.map(({ source, relative }) => {
      const internalPath = path.posix.join(
        "states",
        this.segment(visit.stateId),
        "visits",
        String(visit.number),
        "tasks",
        this.segment(task.id),
        "documents",
        ...relative.split(path.sep),
      );
      const durablePath = this.durablePath(
        this.runDirectory(run),
        internalPath,
      );
      const existing = run.documents.find(
        (document) => document.internalPath === internalPath,
      );
      return { source, relative, internalPath, durablePath, existing };
    });
    if (
      new Set(planned.map((document) => document.internalPath)).size !==
      planned.length
    )
      throw new ResultValidationError(
        "documents_invalid",
        "Result documents contain a provenance collision",
      );
    for (const {
      source,
      relative,
      internalPath,
      durablePath,
      existing,
    } of planned) {
      const sourceContent = await readFile(source);
      const sourceHash = createHash("sha256")
        .update(sourceContent)
        .digest("hex");
      if (existing) {
        if (existing.sha256 !== sourceHash)
          throw new ResultValidationError(
            "documents_invalid",
            `Document provenance collision: ${internalPath}`,
          );
        records.push(existing);
        continue;
      }
      await mkdir(path.dirname(durablePath), { recursive: true });
      try {
        await copyFile(source, durablePath, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const durableHash = createHash("sha256")
          .update(await readFile(durablePath))
          .digest("hex");
        if (durableHash !== sourceHash)
          throw new ResultValidationError(
            "documents_invalid",
            `Document provenance collision: ${internalPath}`,
          );
      }
      const content = await readFile(durablePath);
      records.push({
        stateId: visit.stateId,
        visitNumber: visit.number,
        taskId: task.id,
        name: path.posix.basename(relative.split(path.sep).join("/")),
        internalPath,
        durablePath,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
    return records;
  }

  private async validateDocuments(
    outputDirectory: string,
    names: readonly string[],
  ): Promise<Array<{ source: string; relative: string }>> {
    const outputRoot = await realpath(outputDirectory);
    return Promise.all(
      names.map(async (name) => {
        if (!name || path.isAbsolute(name))
          throw new ResultValidationError(
            "documents_invalid",
            `Invalid result document: ${name}`,
          );
        const candidate = path.resolve(outputRoot, name);
        const relative = path.relative(outputRoot, candidate);
        if (
          relative.startsWith(`..${path.sep}`) ||
          relative === ".." ||
          path.isAbsolute(relative) ||
          path.extname(candidate).toLowerCase() !== ".md"
        )
          throw new ResultValidationError(
            "documents_invalid",
            `Invalid result document: ${name}`,
          );
        try {
          const [entry, resolved, file] = await Promise.all([
            lstat(candidate),
            realpath(candidate),
            stat(candidate),
          ]);
          const resolvedRelative = path.relative(outputRoot, resolved);
          if (
            entry.isSymbolicLink() ||
            resolved !== candidate ||
            !file.isFile() ||
            resolvedRelative.startsWith(`..${path.sep}`) ||
            resolvedRelative === ".." ||
            path.isAbsolute(resolvedRelative)
          )
            throw new Error();
          return { source: resolved, relative };
        } catch {
          throw new ResultValidationError(
            "documents_invalid",
            `Invalid result document: ${name}`,
          );
        }
      }),
    );
  }

  private isJsonValue(value: unknown): boolean {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value))
      return value.every((item) => this.isJsonValue(item));
    if (!value || typeof value !== "object") return false;
    return Object.values(value).every((item) => this.isJsonValue(item));
  }

  private runDirectory(run: RunRecord): string {
    return this.runDirectoryFor(run.projectRoot, run.id);
  }

  private runDirectoryFor(projectRoot: string, runId: string): string {
    return path.join(projectRoot, ".happy-machine", "runs", runId);
  }

  private artifacts(request: SnapshotCreationRequest): StoredArtifact[] {
    const sourceArtifacts = [...request.source.artifacts].sort(
      (left, right) => {
        const order = {
          project_configuration: 0,
          workflow: 1,
          agent_instructions: 2,
          inline_prompt: 3,
          prompt_file: 3,
        } as Record<string, number>;
        return (
          order[left.kind] - order[right.kind] ||
          this.compare(left.logicalId, right.logicalId) ||
          this.compare(left.kind, right.kind)
        );
      },
    );
    let agentNumber = 0;
    let promptNumber = 0;
    const artifacts: StoredArtifact[] = sourceArtifacts.map((source) => {
      let internalPath: string;
      if (source.kind === "project_configuration")
        internalPath = "definition/happy-machine.yaml";
      else if (source.kind === "workflow")
        internalPath = "definition/workflow.yaml";
      else if (source.kind === "agent_instructions") {
        agentNumber += 1;
        internalPath = `definition/agents/agent-${this.number(agentNumber)}/instructions.md`;
      } else {
        promptNumber += 1;
        internalPath = `definition/prompts/prompt-${this.number(promptNumber)}/prompt.md`;
      }
      return {
        kind: source.kind,
        logicalId: source.logicalId,
        internalPath,
        sha256: this.sha256(source.content),
        content: source.content,
      };
    });
    const effectiveContent = `${JSON.stringify(
      this.canonical(request.source.effectiveDefinition),
      null,
      2,
    )}\n`;
    artifacts.push({
      kind: "effective_definition",
      logicalId: "effective",
      internalPath: "definition/effective.json",
      sha256: this.sha256(effectiveContent),
      content: effectiveContent,
    });
    for (const input of request.source.inputs) {
      const internalPath = path.posix.join(
        "inputs",
        input.id,
        input.originalName,
      );
      artifacts.push({
        kind: "input",
        logicalId: input.id,
        originalName: input.originalName,
        internalPath,
        sha256: this.sha256(input.content),
        content: input.content,
      });
    }
    return artifacts.sort((left, right) =>
      this.compare(left.internalPath, right.internalPath),
    );
  }

  private async writeExclusive(
    root: string,
    internalPath: string,
    content: string,
  ): Promise<void> {
    const target = this.durablePath(root, internalPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
  }

  private durablePath(root: string, internalPath: string): string {
    return path.join(root, ...internalPath.split("/"));
  }

  private sha256(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

  private number(value: number): string {
    return String(value).padStart(4, "0");
  }

  private compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  private segment(value: string): string {
    return encodeURIComponent(value).replaceAll(".", "%2E");
  }

  private canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.canonical(item));
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        const child = (value as Record<string, unknown>)[key];
        if (child !== undefined) result[key] = this.canonical(child);
      }
      return result;
    }
    return value;
  }
}
