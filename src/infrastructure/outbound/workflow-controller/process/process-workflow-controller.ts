import { createHash, randomUUID } from "node:crypto";
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunRecord } from "../../../../domain/execution/run.js";
import type { RunRepository } from "../../../../ports/run-repository.js";
import type {
  ChildControllerCancellation,
  ChildControllerDiagnostics,
  ChildControllerExecution,
  ChildControllerExternalIdentity,
  ChildControllerLaunch,
  ChildControllerObservation,
  ChildControllerProvenance,
  ChildControllerReconciliation,
  ChildControllerRecovery,
  WorkflowController,
} from "../../../../ports/workflow-controller.js";
import { WorkflowControllerUncertaintyError } from "../../../../ports/workflow-controller.js";

export type WorkflowControllerSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

interface ControllerRecord {
  identity: ChildControllerExternalIdentity;
  diagnostics: ChildControllerDiagnostics;
  pid?: number;
}

export interface ProcessWorkflowControllerOptions {
  executable?: string;
  entrypoint?: string;
  spawnProcess?: WorkflowControllerSpawn;
  processIsAlive?: (processId: number) => boolean;
  killProcess?: (processId: number, signal: NodeJS.Signals) => void;
  makeId?: () => string;
}

export class ProcessWorkflowController implements WorkflowController {
  private readonly executable: string;
  private readonly entrypoint: string;
  private readonly spawnProcess: WorkflowControllerSpawn;
  private readonly processIsAlive: (processId: number) => boolean;
  private readonly killProcess: (
    processId: number,
    signal: NodeJS.Signals,
  ) => void;
  private readonly makeId: () => string;

  constructor(
    private readonly runs: RunRepository,
    options: ProcessWorkflowControllerOptions = {},
  ) {
    this.executable = options.executable ?? process.execPath;
    this.entrypoint =
      options.entrypoint ?? process.argv[1] ?? "dist/src/main.js";
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.processIsAlive = options.processIsAlive ?? defaultProcessIsAlive;
    this.killProcess =
      options.killProcess ??
      ((processId, signal) => process.kill(processId, signal));
    this.makeId = options.makeId ?? randomUUID;
  }

  async start(
    request: ChildControllerLaunch,
  ): Promise<ChildControllerExecution> {
    this.assertLaunch(request);
    const existing = await this.findRecord(
      request.projectRoot,
      request.provenance,
    );
    if (existing) {
      const observed = await this.observe(existing);
      if (observed.status !== "not_started")
        return {
          identity: this.identity(existing),
          diagnostics: existing.diagnostics,
        };
    }
    const identity: ChildControllerExternalIdentity = {
      executionId: this.makeId(),
      provenance: structuredClone(request.provenance),
    };
    const diagnostics = this.paths(request.projectRoot, identity);
    const record: ControllerRecord = { identity, diagnostics };
    await this.persistRecord(record);
    await writeFile(diagnostics.stdoutPath, "");
    await writeFile(diagnostics.stderrPath, "");
    let child: ChildProcess;
    try {
      child = this.spawnProcess(
        this.executable,
        [this.entrypoint, "resume", request.childRunId],
        {
          cwd: request.projectRoot,
          env: process.env,
          shell: false,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (cause) {
      throw new WorkflowControllerUncertaintyError(
        "start_unknown",
        `Child controller could not be started: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    record.pid = child.pid ?? undefined;
    await this.persistRecord(record);
    this.capture(child, diagnostics);
    child.unref();
    return { identity, diagnostics };
  }

  async recover(
    request: ChildControllerRecovery,
  ): Promise<ChildControllerObservation> {
    const record = await this.findRecord(
      request.projectRoot,
      request.provenance,
    );
    if (!record)
      return { status: "not_started", provenance: request.provenance };
    return this.observe(record);
  }

  async cancel(request: ChildControllerCancellation): Promise<void> {
    const record = await this.readRecord(request.projectRoot, request.identity);
    if (!record) return;
    if (record.pid === undefined || !this.processIsAlive(record.pid)) return;
    try {
      this.killProcess(record.pid, "SIGTERM");
    } catch (cause) {
      throw new WorkflowControllerUncertaintyError(
        "stop_unknown",
        `Child controller ${record.identity.executionId} could not be stopped: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  async reconcile(
    request: ChildControllerReconciliation,
  ): Promise<ChildControllerObservation> {
    const record = await this.readRecord(request.projectRoot, request.identity);
    if (!record)
      return {
        status: "irreconcilable",
        identity: request.identity,
        diagnostics: this.paths(request.projectRoot, request.identity),
        message: "Child controller provenance is missing.",
      };
    return this.observe(record);
  }

  private async observe(
    record: ControllerRecord,
  ): Promise<ChildControllerObservation> {
    const run = await this.loadRun(record.identity.provenance);
    if (isTerminal(run))
      return {
        status: "terminal",
        identity: record.identity,
        terminalStatus: run.status,
        diagnostics: record.diagnostics,
      };
    if (record.pid !== undefined && this.processIsAlive(record.pid))
      return {
        status: "active",
        identity: record.identity,
        diagnostics: record.diagnostics,
      };
    return {
      status: "irreconcilable",
      identity: record.identity,
      diagnostics: record.diagnostics,
      message: "The controller is absent while the child run is still active.",
    };
  }

  private assertLaunch(request: ChildControllerLaunch): void {
    if (request.childRunId !== request.provenance.childRunId)
      throw new Error(
        "Child controller launch identity does not match provenance",
      );
    if (request.projectRoot !== request.provenance.projectRoot)
      throw new Error("Child controller launch root does not match provenance");
  }

  private async loadRun(
    provenance: ChildControllerProvenance,
  ): Promise<RunRecord> {
    if (!this.runs.loadChildRun)
      throw new Error("Run repository does not support child-run loading");
    return (
      await this.runs.loadChildRun(
        provenance.projectRoot,
        provenance.childRunId,
      )
    ).run;
  }

  private identity(record: ControllerRecord): ChildControllerExternalIdentity {
    return structuredClone(record.identity);
  }

  private directory(projectRoot: string): string {
    return path.join(projectRoot, ".happy-machine", "controllers");
  }

  private paths(
    projectRoot: string,
    identity: ChildControllerExternalIdentity,
  ): ChildControllerDiagnostics {
    const stem = this.fileStem(identity.provenance);
    return {
      stdoutPath: path.join(this.directory(projectRoot), `${stem}.stdout.log`),
      stderrPath: path.join(this.directory(projectRoot), `${stem}.stderr.log`),
    };
  }

  private fileStem(provenance: ChildControllerProvenance): string {
    return createHash("sha256")
      .update(JSON.stringify(provenance))
      .digest("hex");
  }

  private recordPath(
    projectRoot: string,
    provenance: ChildControllerProvenance,
  ): string {
    return path.join(
      this.directory(projectRoot),
      `${this.fileStem(provenance)}.json`,
    );
  }

  private async persistRecord(record: ControllerRecord): Promise<void> {
    await mkdir(
      path.dirname(
        this.recordPath(
          record.identity.provenance.projectRoot,
          record.identity.provenance,
        ),
      ),
      { recursive: true },
    );
    await writeFile(
      this.recordPath(
        record.identity.provenance.projectRoot,
        record.identity.provenance,
      ),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  }

  private async findRecord(
    projectRoot: string,
    provenance: ChildControllerProvenance,
  ): Promise<ControllerRecord | undefined> {
    return this.readRecord(projectRoot, { executionId: "", provenance });
  }

  private async readRecord(
    projectRoot: string,
    identity: ChildControllerExternalIdentity,
  ): Promise<ControllerRecord | undefined> {
    const recordPath = this.recordPath(projectRoot, identity.provenance);
    if (!existsSync(recordPath)) return undefined;
    try {
      const record = JSON.parse(
        await readFile(recordPath, "utf8"),
      ) as ControllerRecord;
      if (
        identity.executionId &&
        record.identity.executionId !== identity.executionId
      )
        return undefined;
      return record;
    } catch (cause) {
      throw new WorkflowControllerUncertaintyError(
        "irreconcilable",
        `Child controller provenance is corrupt: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  private capture(
    child: ChildProcess,
    diagnostics: ChildControllerDiagnostics,
  ): void {
    void mkdir(path.dirname(diagnostics.stdoutPath), { recursive: true });
    child.stdout?.pipe(createWriteStream(diagnostics.stdoutPath));
    child.stderr?.pipe(createWriteStream(diagnostics.stderrPath));
  }
}

function isTerminal(
  run: RunRecord,
): run is RunRecord & { status: "succeeded" | "failed" | "canceled" } {
  return (
    run.status === "succeeded" ||
    run.status === "failed" ||
    run.status === "canceled"
  );
}

function defaultProcessIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
