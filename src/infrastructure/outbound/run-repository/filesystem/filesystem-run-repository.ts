import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunRecord } from "../../../../domain/execution/run.js";
import type {
  AttemptPaths,
  RunRepository,
} from "../../../../ports/run-repository.js";

export class FilesystemRunRepository implements RunRepository {
  async save(run: RunRecord): Promise<void> {
    const directory = this.runDirectory(run);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, "run.json");
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  async prepareAttempt(
    run: RunRecord,
    instructions: string,
    prompt: string,
  ): Promise<AttemptPaths> {
    const visit = run.visits.at(-1)!;
    const attempt = visit.task.attempts.at(-1)!;
    const controlWorkspace = path.join(
      this.runDirectory(run),
      "states",
      visit.stateId,
      "visits",
      String(visit.number),
      "tasks",
      visit.task.id,
      "attempts",
      String(attempt.number),
    );
    const outputDirectory = path.join(controlWorkspace, "output");
    const contextPath = path.join(controlWorkspace, "context.md");
    const resultPath = path.join(controlWorkspace, "result.json");
    await mkdir(outputDirectory, { recursive: true });
    const context = [
      "# Happy Machine Attempt Context",
      "",
      `Attempt identity: ${attempt.id}`,
      `Project workspace: ${run.projectRoot}`,
      `Output directory: ${outputDirectory}`,
      `Result file: ${resultPath}`,
      "",
      "## Agent instructions",
      "",
      instructions.trim(),
      "",
      "## Task prompt",
      "",
      prompt.trim(),
      "",
      "## Result contract",
      "",
      `Write JSON to ${resultPath} with exactly an outcome string and a documents array.`,
      `Place declared Markdown documents beneath ${outputDirectory}. Standard output and error never select the outcome.`,
      "",
    ].join("\n");
    await writeFile(contextPath, context, { encoding: "utf8", flag: "wx" });
    return { controlWorkspace, contextPath, outputDirectory, resultPath };
  }

  async readResult(
    resultPath: string,
    outputDirectory: string,
    allowedOutcomes: readonly string[],
  ): Promise<{ outcome: string; documents: string[] }> {
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
    for (const document of result.documents as string[]) {
      if (path.isAbsolute(document))
        throw new Error("Result document paths must be relative");
      const file = path.resolve(outputDirectory, document);
      const relative = path.relative(outputDirectory, file);
      let validFile = false;
      try {
        validFile = (await stat(file)).isFile();
      } catch {
        // The validation below reports missing or inaccessible files.
      }
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        path.extname(file).toLowerCase() !== ".md" ||
        !validFile
      )
        throw new Error(`Invalid result document: ${document}`);
    }
    return { outcome: result.outcome, documents: result.documents as string[] };
  }

  private runDirectory(run: RunRecord): string {
    return path.join(run.projectRoot, ".happy-machine", "runs", run.id);
  }
}
