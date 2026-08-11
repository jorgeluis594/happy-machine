import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  DocumentRecord,
  RunRecord,
} from "../../../../domain/execution/run.js";
import type {
  AttemptPaths,
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

  async save(run: RunRecord): Promise<void> {
    const directory = this.runDirectory(run);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, "run.json");
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    await rename(temporary, target);
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
    ].join("\n");
    await writeFile(contextPath, context, { encoding: "utf8", flag: "wx" });
    return contextPath;
  }

  async prepareAttempt(run: RunRecord): Promise<AttemptPaths> {
    const visit = run.visits.at(-1)!;
    const attempt = visit.task.attempts.at(-1)!;
    const controlWorkspace = path.join(
      this.runDirectory(run),
      "states",
      visit.stateId,
      "visits",
      String(visit.number),
      "tasks",
      this.segment(visit.task.id),
      "attempts",
      String(attempt.number),
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
      throw new Error(`Missing or invalid result.json: ${resultPath}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("result.json must contain an object");
    const result = value as Record<string, unknown>;
    if (
      typeof result.outcome !== "string" ||
      !allowedOutcomes.includes(result.outcome)
    )
      throw new Error("result.json contains an unknown outcome");
    if (
      !Array.isArray(result.documents) ||
      result.documents.some((item) => typeof item !== "string")
    )
      throw new Error("result.json documents must be an array of paths");
    await this.validateDocuments(outputDirectory, result.documents as string[]);
    if ("error" in result && !this.isJsonValue(result.error))
      throw new Error("result.json error must be serializable diagnostic data");
    return {
      outcome: result.outcome,
      documents: result.documents as string[],
      ...(result.error === undefined ? {} : { error: result.error }),
    } as ValidatedNormalResult;
  }

  async stageDocuments(
    run: RunRecord,
    outputDirectory: string,
    names: readonly string[],
  ): Promise<DocumentRecord[]> {
    const visit = run.visits.at(-1)!;
    const validated = await this.validateDocuments(outputDirectory, names);
    const records: DocumentRecord[] = [];
    const planned = validated.map(({ source, relative }) => {
      const internalPath = path.posix.join(
        "states",
        this.segment(visit.stateId),
        "visits",
        String(visit.number),
        "tasks",
        this.segment(visit.task.id),
        "documents",
        ...relative.split(path.sep),
      );
      if (
        run.documents.some((document) => document.internalPath === internalPath)
      )
        throw new Error(`Document provenance collision: ${internalPath}`);
      const durablePath = this.durablePath(
        this.runDirectory(run),
        internalPath,
      );
      return { source, relative, internalPath, durablePath };
    });
    if (
      new Set(planned.map((document) => document.internalPath)).size !==
      planned.length
    )
      throw new Error("Result documents contain a provenance collision");
    for (const { source, relative, internalPath, durablePath } of planned) {
      await mkdir(path.dirname(durablePath), { recursive: true });
      await copyFile(source, durablePath, constants.COPYFILE_EXCL);
      const content = await readFile(durablePath);
      records.push({
        stateId: visit.stateId,
        visitNumber: visit.number,
        taskId: visit.task.id,
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
          throw new Error(`Invalid result document: ${name}`);
        const candidate = path.resolve(outputRoot, name);
        const relative = path.relative(outputRoot, candidate);
        if (
          relative.startsWith(`..${path.sep}`) ||
          relative === ".." ||
          path.isAbsolute(relative) ||
          path.extname(candidate).toLowerCase() !== ".md"
        )
          throw new Error(`Invalid result document: ${name}`);
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
          throw new Error(`Invalid result document: ${name}`);
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
