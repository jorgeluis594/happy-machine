import { describe, expect, it } from "vitest";
import { CliDiagnostics } from "../src/infrastructure/inbound/cli/debug-presenter.js";

describe("CLI debug presenter", () => {
  it("is silent outside a debug scope and prefixes sanitized transcript", async () => {
    const lines: string[] = [];
    const diagnostics = new CliDiagnostics(
      (line) => lines.push(line),
      () => new Date("2026-08-12T12:00:00.000Z"),
    );
    diagnostics.emit({ kind: "event", name: "ignored" });
    await diagnostics.run({ enabled: true, replay: true }, async () => {
      await Promise.resolve();
      diagnostics.emit({
        kind: "transcript",
        name: "agent",
        source: "terminal",
        replay: true,
        context: {
          runId: "run_1",
          stateId: "draft",
          visitNumber: 1,
          taskId: "writer",
          attemptNumber: 2,
          dispatchId: "d1",
        },
        text: "\u001b[31mhello\u001b[0m\u0000",
      });
    });
    expect(lines).toEqual([
      "[2026-08-12T12:00:00.000Z] debug run=run_1 state=draft visit=1 task=writer attempt=2 dispatch=d1 source=terminal replay=true transcript=agent hello",
    ]);
  });

  it("truncates each payload by UTF-8 bytes", async () => {
    const lines: string[] = [];
    const diagnostics = new CliDiagnostics((line) => lines.push(line));
    await diagnostics.run({ enabled: true, replay: false }, async () => {
      await Promise.resolve();
      diagnostics.emit({
        kind: "transcript",
        name: "agent",
        text: "é".repeat(2000),
      });
    });
    expect(lines[0]).toContain("bytes omitted]");
    expect(Buffer.byteLength(lines[0] ?? "")).toBeLessThan(2300);
  });
});
