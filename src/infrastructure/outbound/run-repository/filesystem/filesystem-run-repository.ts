import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  cp,
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
  DefinitionSnapshotRecord,
  DocumentRecord,
  RunRecord,
  JsonValue,
  StructuredOutputRecord,
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
  ChildRunCreationRequest,
  ChildRunReservationRequest,
  EvaluationContextRecord,
  ReservedChildRun,
  WorkflowTaskResultCommitRequest,
} from "../../../../ports/run-repository.js";
import type { StructuredOutputDefinition } from "../../../../ports/project-definitions.js";

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
      definition = this.normalizeDefinition(manifest.effectiveDefinition);
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

  private normalizeDefinition(value: unknown): RecoveredRun["definition"] {
    const definition = structuredClone(value) as RecoveredRun["definition"];
    if (!definition || typeof definition !== "object") return definition;

    const normalizeAgent = (agent: unknown): void => {
      if (!agent || typeof agent !== "object" || Array.isArray(agent)) return;
      const record = agent as Record<string, unknown>;
      if (record.runtime === undefined) {
        record.runtime = "codex";
        delete record.model;
      }
    };

    if (
      definition.agents &&
      typeof definition.agents === "object" &&
      !Array.isArray(definition.agents)
    )
      for (const agent of Object.values(definition.agents))
        normalizeAgent(agent);

    if (
      definition.states &&
      typeof definition.states === "object" &&
      !Array.isArray(definition.states)
    )
      for (const state of Object.values(definition.states)) {
        if (!state || typeof state !== "object") continue;
        if (state.type === "agent") normalizeAgent(state.agent);
        else if (state.type === "parallel")
          for (const task of Object.values(state.tasks ?? {}))
            normalizeAgent(task.agent);
        if (state.type === "parallel" && state.mode === "dynamic")
          if (state.task && "agent" in state.task)
            normalizeAgent(state.task.agent);
      }

    return definition;
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

  async claimCleanupPrompt(
    projectRoot: string,
    runId: string,
    shownAt: string,
  ): Promise<RunRecord | undefined> {
    return this.withRunLock(projectRoot, runId, async () => {
      const { run } = await this.load(projectRoot, runId);
      if (
        !runIsTerminal(run.status) ||
        run.workspace?.mode !== "worktree" ||
        run.workspace.worktrees.length === 0 ||
        run.cleanup?.promptShownAt
      )
        return;
      run.cleanup ??= { evaluations: [] };
      run.cleanup.promptShownAt = shownAt;
      run.cleanup.decision = "pending";
      run.events.push({
        sequence: run.events.length + 1,
        type: "worktree_cleanup_prompt_shown",
        at: shownAt,
        data: {},
      });
      await this.writeRun(run);
      return run;
    });
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

  async reserveChildRun(
    request: ChildRunReservationRequest,
  ): Promise<ReservedChildRun> {
    return this.withRunLock(
      request.projectRoot,
      request.parentRunId,
      async () => {
        const parent = (
          await this.load(request.projectRoot, request.parentRunId)
        ).run;
        this.requireParentCoordinate(parent, request.coordinate);
        const existing = parent.childRunReservations?.find((reservation) =>
          this.sameCoordinate(reservation.coordinate, request.coordinate),
        );
        const childRunId =
          existing?.childRunId ?? this.childRunId(request.coordinate);
        const candidate: ReservedChildRun = {
          childRunId,
          coordinate: structuredClone(request.coordinate),
          workflowId: request.workflowId,
          workflowSnapshotIdentity: request.workflowSnapshotIdentity,
          resolvedWith: structuredClone(request.resolvedWith),
        };
        if (existing) {
          if (!this.sameReservation(existing, candidate))
            throw new Error(
              "Child run reservation conflicts with durable intent",
            );
          return existing;
        }
        parent.childRunReservations ??= [];
        parent.childRunReservations.push(candidate);
        await this.writeRun(parent);
        return candidate;
      },
    );
  }

  async getOrCreateChildRun(
    request: ChildRunCreationRequest,
  ): Promise<RunRecord> {
    const reservation = await this.reserveChildRun(request);
    const childDirectory = this.runDirectoryFor(
      request.projectRoot,
      reservation.childRunId,
    );
    return this.withRunLock(
      request.projectRoot,
      reservation.childRunId,
      async () => {
        const childPath = path.join(childDirectory, "run.json");
        if (await this.exists(childPath)) {
          const child = (
            await this.loadChildRun(request.projectRoot, reservation.childRunId)
          ).run;
          this.validateChildRequest(child, request, reservation);
          return child;
        }
        await mkdir(childDirectory, { recursive: true });
        const snapshotDirectory = path.join(childDirectory, "snapshot");
        const stagingSnapshot = await mkdtemp(
          path.join(childDirectory, ".snapshot-"),
        );
        let childSnapshotIdentity: string;
        try {
          await cp(request.parentSnapshot.directory, stagingSnapshot, {
            recursive: true,
          });
          const manifestPath = path.join(stagingSnapshot, "manifest.json");
          const manifest = JSON.parse(
            await readFile(manifestPath, "utf8"),
          ) as Record<string, unknown>;
          const effectiveContent = `${JSON.stringify(this.canonical(request.workflowDefinition), null, 2)}\n`;
          await writeFile(
            path.join(stagingSnapshot, "definition", "effective.json"),
            effectiveContent,
            "utf8",
          );
          const payload = this.canonical({
            ...manifest,
            identity: undefined,
            workflowId: request.workflowId,
            effectiveDefinition: request.workflowDefinition,
            artifacts: (manifest.artifacts as unknown[]).map((artifact) =>
              artifact &&
              typeof artifact === "object" &&
              "internalPath" in artifact &&
              (artifact as { internalPath: string }).internalPath ===
                "definition/effective.json"
                ? {
                    ...(artifact as Record<string, unknown>),
                    sha256: this.sha256(effectiveContent),
                  }
                : artifact,
            ),
          }) as Record<string, unknown>;
          delete payload.identity;
          const identity = `sha256:${this.sha256(JSON.stringify(payload))}`;
          childSnapshotIdentity = identity;
          await writeFile(
            manifestPath,
            `${JSON.stringify({ ...payload, identity }, null, 2)}\n`,
            "utf8",
          );
          await rename(stagingSnapshot, snapshotDirectory);
        } catch (error) {
          await rm(stagingSnapshot, { recursive: true, force: true });
          throw error;
        }
        const snapshot: DefinitionSnapshotRecord = {
          identity: childSnapshotIdentity,
          directory: snapshotDirectory,
          manifestPath: path.join(snapshotDirectory, "manifest.json"),
          inputs: request.parentSnapshot.inputs.map((input) => ({
            ...input,
            durablePath: this.durablePath(
              snapshotDirectory,
              input.internalPath,
            ),
          })),
        };
        const child: RunRecord = {
          id: reservation.childRunId,
          workflowId: request.workflowId,
          workflowPath: request.workflowId,
          projectRoot: request.projectRoot,
          definitionSnapshot: snapshot,
          parent: {
            runId: request.parentRunId,
            stateId: request.coordinate.stateId,
            visitNumber: request.coordinate.visitNumber,
            taskId: request.coordinate.taskId,
          },
          status: "running",
          controllerStatus: "detached",
          createdAt: request.createdAt,
          deadlineAt: request.deadlineAt,
          transitionCount: 0,
          visits: [],
          documents: [],
          events: [],
        };
        child.childBindings = structuredClone(reservation.resolvedWith);
        child.workflowSnapshotIdentity = request.workflowSnapshotIdentity;
        const bindingContext = path.join(childDirectory, "context.md");
        const bindingContent = `# Workflow Context\n\n## Immutable workflow bindings\n\nThese values were resolved before the child run was created.\n\n\`\`\`json\n${JSON.stringify(this.canonical(child.childBindings), null, 2)}\n\`\`\`\n`;
        const bindingTemporary = `${bindingContext}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(bindingTemporary, bindingContent, "utf8");
        await rename(bindingTemporary, bindingContext);
        await this.writeRun(child);
        return child;
      },
    );
  }

  async loadChildRun(
    projectRoot: string,
    childRunId: string,
  ): Promise<RecoveredRun> {
    const recovered = await this.load(projectRoot, childRunId);
    if (!recovered.run.parent) throw new Error("Run is not a workflow child");
    const parent = (await this.load(projectRoot, recovered.run.parent.runId))
      .run;
    const reservation = parent.childRunReservations?.find(
      (candidate) => candidate.childRunId === childRunId,
    );
    if (
      !reservation ||
      !this.sameCoordinate(reservation.coordinate, {
        parentRunId: recovered.run.parent.runId,
        stateId: recovered.run.parent.stateId,
        visitNumber: recovered.run.parent.visitNumber,
        taskId: recovered.run.parent.taskId,
      })
    )
      throw new Error("Child run provenance is inconsistent");
    return recovered;
  }

  async stageWorkflowTaskEvaluationContext(request: {
    parent: RunRecord;
    coordinate: import("../../../../domain/execution/workflow-task.js").WorkflowTaskCoordinate;
    resolvedWith: Record<string, JsonValue>;
    childRunId: string;
  }): Promise<EvaluationContextRecord> {
    this.requireParentCoordinate(request.parent, request.coordinate);
    const directory = path.join(
      this.runDirectory(request.parent),
      "workflow-evaluations",
      this.segment(request.childRunId),
    );
    const target = path.join(directory, "context.md");
    const content = `# Workflow task evaluation context\n\n## Resolved bindings\n\n\`\`\`json\n${JSON.stringify(this.canonical(request.resolvedWith), null, 2)}\n\`\`\`\n`;
    await mkdir(directory, { recursive: true });
    await writeFile(target, content, { encoding: "utf8", flag: "wx" }).catch(
      async (error: NodeJS.ErrnoException) => {
        if (
          error.code !== "EEXIST" ||
          (await readFile(target, "utf8")) !== content
        )
          throw error;
      },
    );
    return { path: target, sha256: this.sha256(content) };
  }

  async commitWorkflowTaskResult(
    request: WorkflowTaskResultCommitRequest,
  ): Promise<RunRecord> {
    return this.withRunLock(
      request.parent.projectRoot,
      request.parent.id,
      async () => {
        const current = (
          await this.load(request.parent.projectRoot, request.parent.id)
        ).run;
        this.requireParentCoordinate(current, request.coordinate);
        if (request.envelope.childRunId !== this.childRunId(request.coordinate))
          throw new Error(
            "Workflow result provenance does not match its coordinate",
          );
        const visit = current.visits.find(
          (candidate) =>
            candidate.type === "parallel" &&
            candidate.stateId === request.coordinate.stateId &&
            candidate.number === request.coordinate.visitNumber,
        );
        const task =
          visit && visit.type === "parallel"
            ? visit.tasks.find(
                (candidate) => candidate.id === request.coordinate.taskId,
              )
            : undefined;
        if (!task || task.execution?.type !== "workflow")
          throw new Error("Workflow wrapper is missing");
        task.execution.evaluationAttempts = [structuredClone(request.attempt)];
        task.execution.result = structuredClone(request.envelope);
        task.execution.phase = request.envelope.status;
        task.documents = structuredClone(request.documents);
        task.status = request.envelope.status;
        task.outcome =
          request.envelope.status === "succeeded" ? "succeeded" : undefined;
        current.events.push(
          ...structuredClone(request.events).map((event, index) => ({
            ...event,
            sequence: current.events.length + index + 1,
          })),
        );
        await this.writeRun(current);
        return current;
      },
    );
  }

  private async writeRun(run: RunRecord): Promise<void> {
    const directory = this.runDirectory(run);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, "run.json");
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  private childRunId(coordinate: {
    parentRunId: string;
    stateId: string;
    visitNumber: number;
    taskId: string;
  }): string {
    return `child_${this.sha256(JSON.stringify(this.canonical(coordinate))).slice(0, 32)}`;
  }

  private sameCoordinate(
    left: {
      parentRunId: string;
      stateId: string;
      visitNumber: number;
      taskId: string;
    },
    right: {
      parentRunId: string;
      stateId: string;
      visitNumber: number;
      taskId: string;
    },
  ): boolean {
    return (
      left.parentRunId === right.parentRunId &&
      left.stateId === right.stateId &&
      left.visitNumber === right.visitNumber &&
      left.taskId === right.taskId
    );
  }

  private sameReservation(
    left: {
      coordinate: {
        parentRunId: string;
        stateId: string;
        visitNumber: number;
        taskId: string;
      };
      workflowId: string;
      workflowSnapshotIdentity: string;
      resolvedWith: Record<string, JsonValue>;
    },
    right: ReservedChildRun,
  ): boolean {
    return (
      this.sameCoordinate(left.coordinate, right.coordinate) &&
      left.workflowId === right.workflowId &&
      left.workflowSnapshotIdentity === right.workflowSnapshotIdentity &&
      JSON.stringify(this.canonical(left.resolvedWith)) ===
        JSON.stringify(this.canonical(right.resolvedWith))
    );
  }

  private requireParentCoordinate(
    parent: RunRecord,
    coordinate: {
      parentRunId: string;
      stateId: string;
      visitNumber: number;
      taskId: string;
    },
  ): void {
    if (parent.id !== coordinate.parentRunId)
      throw new Error("Child run coordinate does not belong to parent");
    const visit = parent.visits.find(
      (candidate) =>
        candidate.stateId === coordinate.stateId &&
        candidate.number === coordinate.visitNumber,
    );
    if (
      visit?.type === "parallel" &&
      !visit.tasks.some((task) => task.id === coordinate.taskId)
    )
      throw new Error("Child run coordinate does not identify a parent task");
  }

  private validateChildRequest(
    child: RunRecord,
    request: ChildRunCreationRequest,
    reservation: ReservedChildRun,
  ): void {
    if (
      child.id !== reservation.childRunId ||
      child.workflowId !== request.workflowId ||
      !child.parent ||
      child.parent.runId !== request.parentRunId ||
      !this.sameCoordinate(
        { ...child.parent, parentRunId: child.parent.runId },
        request.coordinate,
      )
    )
      throw new Error("Existing child run conflicts with durable provenance");
    if (child.workflowSnapshotIdentity !== request.workflowSnapshotIdentity)
      throw new Error("Existing child run conflicts with workflow snapshot");
    if (
      JSON.stringify(this.canonical(child.childBindings ?? {})) !==
      JSON.stringify(this.canonical(reservation.resolvedWith))
    )
      throw new Error("Existing child run conflicts with immutable bindings");
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
    await mkdir(path.dirname(lock), { recursive: true });
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
    const bindingIndex = run.childBindings
      ? [
          "## Immutable workflow bindings",
          "",
          "These values were resolved before the child run was created.",
          "",
          "```json",
          JSON.stringify(this.canonical(run.childBindings), null, 2),
          "```",
          "",
        ]
      : [];
    const worktreeIndex = run.workspace?.worktrees.flatMap((worktree) => [
      `### ${worktree.id}`,
      "",
      `- Role: ${worktree.role}`,
      ...(worktree.provenance
        ? [
            `- State: ${JSON.stringify(worktree.provenance.stateId)}`,
            `- Visit: ${worktree.provenance.visitNumber}`,
            `- Task: ${JSON.stringify(worktree.provenance.taskId)}`,
          ]
        : []),
      `- Path: ${JSON.stringify(worktree.path)}`,
      `- Branch: ${JSON.stringify(worktree.branch)}`,
      `- Starting HEAD: \`${worktree.startingHead}\``,
      `- Ending HEAD: \`${worktree.endingHead}\``,
      `- Dirty: ${String(worktree.dirty)}`,
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
      ...(bindingIndex.length ? bindingIndex : []),
      ...(inputIndex.length
        ? inputIndex
        : ["No input documents were supplied for this run.", ""]),
      "## Workflow documents",
      "",
      ...(documentIndex.length
        ? documentIndex
        : ["No workflow documents have been committed yet.", ""]),
      "## Project workspace",
      "",
      `Mode: ${run.workspace?.mode ?? "direct"}`,
      "",
      ...(run.workspace?.mode === "worktree"
        ? worktreeIndex?.length
          ? worktreeIndex
          : ["No managed worktrees have been registered yet.", ""]
        : [`Original project path: ${JSON.stringify(run.projectRoot)}`, ""]),
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
    await mkdir(outputDirectory, { recursive: true });
    let contextPath = visit.contextPath;
    if (visit.type === "parallel") {
      const selected = visit.tasks.find((candidate) => candidate === task);
      if (selected?.dynamic) {
        contextPath = path.join(path.dirname(controlWorkspace), "context.md");
        const base = await readFile(visit.contextPath, "utf8");
        const content = `${base}\n\n## Work item\n\n\`\`\`json\n${JSON.stringify(this.canonical(selected.dynamic.workItem), null, 2)}\n\`\`\`\n`;
        await writeFile(contextPath, content, {
          encoding: "utf8",
          flag: "wx",
        }).catch(async (error: NodeJS.ErrnoException) => {
          if (
            error.code !== "EEXIST" ||
            (await readFile(contextPath, "utf8")) !== content
          )
            throw error;
        });
      }
    }
    const resultPath = path.join(controlWorkspace, "result.json");
    return { controlWorkspace, contextPath, outputDirectory, resultPath };
  }

  async readResult(
    resultPath: string,
    outputDirectory: string,
    allowedOutcomes: readonly string[],
    outputDefinitions?: Record<string, StructuredOutputDefinition>,
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
    const allowedFields = new Set([
      "outcome",
      "documents",
      "error",
      ...(outputDefinitions ? ["outputs"] : []),
    ]);
    if (Object.keys(result).some((key) => !allowedFields.has(key)))
      throw new ResultValidationError(
        "result_missing_or_invalid",
        "result.json contains unknown fields",
      );
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
    let outputs: Record<string, JsonValue> | undefined;
    if (outputDefinitions) {
      if (
        !result.outputs ||
        typeof result.outputs !== "object" ||
        Array.isArray(result.outputs)
      )
        throw new ResultValidationError(
          "structured_outputs_invalid",
          "result.json must contain all declared outputs",
        );
      const rawOutputs = result.outputs as Record<string, unknown>;
      if (
        Object.keys(rawOutputs).sort().join("\0") !==
        Object.keys(outputDefinitions).sort().join("\0")
      )
        throw new ResultValidationError(
          "structured_outputs_invalid",
          "result.json outputs must exactly match declared outputs",
        );
      outputs = {};
      for (const [name, definition] of Object.entries(outputDefinitions)) {
        const collection = rawOutputs[name];
        if (
          !Array.isArray(collection) ||
          collection.length > definition.maxItems
        )
          throw new ResultValidationError(
            "structured_outputs_invalid",
            `Output ${name} must be an array of at most ${definition.maxItems} items`,
          );
        const ids = new Set<string>();
        for (const item of collection) {
          if (
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            !this.isJsonValue(item)
          )
            throw new ResultValidationError(
              "structured_outputs_invalid",
              `Output ${name} contains an invalid work item`,
            );
          const id = (item as Record<string, unknown>).id;
          if (
            typeof id !== "string" ||
            id.trim() === "" ||
            id.startsWith("$") ||
            ids.has(id)
          )
            throw new ResultValidationError(
              "structured_outputs_invalid",
              `Output ${name} contains a missing, invalid, or duplicate item id`,
            );
          ids.add(id);
        }
        outputs[name] = collection as JsonValue;
      }
    }
    return {
      outcome: result.outcome,
      documents: result.documents as string[],
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(outputs === undefined ? {} : { outputs }),
    } as ValidatedNormalResult;
  }

  async stageStructuredOutputs(
    run: RunRecord,
    visit: VisitRecord,
    outputs: Readonly<Record<string, JsonValue>>,
  ): Promise<StructuredOutputRecord[]> {
    const records: StructuredOutputRecord[] = [];
    for (const [name, value] of Object.entries(outputs)) {
      const internalPath = path.posix.join(
        "states",
        this.segment(visit.stateId),
        "visits",
        String(visit.number),
        "outputs",
        `${this.segment(name)}.json`,
      );
      const durablePath = this.durablePath(
        this.runDirectory(run),
        internalPath,
      );
      const content = `${JSON.stringify(this.canonical(value), null, 2)}\n`;
      await mkdir(path.dirname(durablePath), { recursive: true });
      await writeFile(durablePath, content, {
        encoding: "utf8",
        flag: "wx",
      }).catch(async (error: NodeJS.ErrnoException) => {
        if (
          error.code !== "EEXIST" ||
          (await readFile(durablePath, "utf8")) !== content
        )
          throw error;
      });
      records.push({
        stateId: visit.stateId,
        visitNumber: visit.number,
        name,
        type: "work_items",
        itemCount: Array.isArray(value) ? value.length : 0,
        durablePath,
        sha256: this.sha256(content),
      });
    }
    return records;
  }

  async readStructuredOutput(
    output: StructuredOutputRecord,
  ): Promise<JsonValue> {
    let content: string;
    try {
      content = await readFile(output.durablePath, "utf8");
    } catch {
      throw new Error(
        "dynamic_source_corrupt: structured output artifact is missing",
      );
    }
    if (this.sha256(content) !== output.sha256)
      throw new Error(
        "dynamic_source_corrupt: structured output artifact hash mismatch",
      );
    try {
      return JSON.parse(content) as JsonValue;
    } catch {
      throw new Error(
        "dynamic_source_corrupt: structured output artifact is invalid JSON",
      );
    }
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
    let childWorkflowNumber = 0;
    const artifacts: StoredArtifact[] = sourceArtifacts.map((source) => {
      let internalPath: string;
      if (source.kind === "project_configuration")
        internalPath = "definition/happy-machine.yaml";
      else if (source.kind === "workflow") {
        if (source.logicalId === "workflow")
          internalPath = "definition/workflow.yaml";
        else {
          childWorkflowNumber += 1;
          internalPath = `definition/workflows/workflow-${this.number(childWorkflowNumber)}.yaml`;
        }
      } else if (source.kind === "agent_instructions") {
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
