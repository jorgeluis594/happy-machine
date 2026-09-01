import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface TraceabilityManifest {
  feature: string;
  scope: string;
  entries: Array<{ id: string; tests: string[]; evidence: string }>;
}

describe("workflow submachines bounded certification", () => {
  it("contains one executable evidence mapping for every acceptance and use case", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.resolve("docs/traceability/workflow-submachines.json"),
        "utf8",
      ),
    ) as TraceabilityManifest;
    expect(manifest).toMatchObject({
      feature: "workflow-submachines",
      scope: "task-08",
    });
    expect(manifest.entries.map((entry) => entry.id)).toEqual([
      ...Array.from(
        { length: 12 },
        (_, index) => `AC-${String(index + 1).padStart(2, "0")}`,
      ),
      ...Array.from(
        { length: 8 },
        (_, index) => `CU-${String(index + 1).padStart(2, "0")}`,
      ),
    ]);
    for (const entry of manifest.entries) {
      expect(entry.tests.length, entry.id).toBeGreaterThan(0);
      expect(entry.evidence, entry.id).not.toBe("");
      for (const test of entry.tests)
        await expect(readFile(path.resolve(test))).resolves.toBeTruthy();
    }
  });
});
