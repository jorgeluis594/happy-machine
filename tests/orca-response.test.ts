import { describe, expect, it } from "vitest";
import {
  decodeOrcaFailure,
  decodeOrcaProcessFailure,
  decodeTerminalClose,
  decodeTerminalCreate,
  decodeTerminalRead,
  decodeTerminalSend,
  decodeTerminalShow,
} from "../src/infrastructure/outbound/task-executor/orca/orca-response.js";

const success = (result: unknown, id = "rpc-envelope-id") => ({
  id,
  ok: true,
  result,
  _meta: { runtimeId: "runtime" },
});

describe("Orca terminal response decoding", () => {
  it("decodes terminal resources without selecting the envelope ID", () => {
    expect(
      decodeTerminalCreate(
        success({ terminal: { handle: "terminal-resource-id" } }),
      ),
    ).toEqual({ terminalHandle: "terminal-resource-id" });
    expect(
      decodeTerminalSend(
        success({
          send: {
            handle: "terminal-resource-id",
            accepted: true,
            bytesWritten: 12,
          },
        }),
      ),
    ).toEqual({
      terminalHandle: "terminal-resource-id",
      accepted: true,
      bytesWritten: 12,
    });
    expect(
      decodeTerminalClose(
        success({ close: { handle: "terminal-resource-id" } }),
      ),
    ).toEqual({ terminalHandle: "terminal-resource-id" });
  });

  it("decodes active and inactive terminal observations", () => {
    expect(
      decodeTerminalShow(
        success({
          terminal: {
            handle: "terminal-resource-id",
            connected: true,
            orphaned: false,
          },
        }),
      ),
    ).toEqual({ terminalHandle: "terminal-resource-id", active: true });
    expect(
      decodeTerminalShow(
        success({
          terminal: {
            handle: "terminal-resource-id",
            connected: true,
            orphaned: true,
          },
        }),
      ),
    ).toEqual({ terminalHandle: "terminal-resource-id", active: false });
  });

  it("decodes bounded terminal transcript pages", () => {
    expect(
      decodeTerminalRead(
        success({
          terminal: {
            handle: "terminal-resource-id",
            status: "running",
            tail: ["working", "done"],
            nextCursor: "opaque:2",
          },
        }),
      ),
    ).toEqual({
      terminalHandle: "terminal-resource-id",
      status: "running",
      cursor: "opaque:2",
      terminalLines: ["working", "done"],
    });
  });

  it("rejects unwrapped and malformed terminal payloads", () => {
    expect(() =>
      decodeTerminalCreate({ terminal: { handle: "terminal" } }),
    ).toThrow("Orca create response expected an RPC envelope with ok=true");
    expect(() => decodeTerminalCreate(success({ terminal: {} }))).toThrow(
      "result.terminal.handle",
    );
    expect(() =>
      decodeTerminalSend(
        success({ send: { handle: "terminal", accepted: "yes" } }),
      ),
    ).toThrow("result.send.accepted");
    expect(() =>
      decodeTerminalShow(
        success({ terminal: { handle: "terminal", connected: "yes" } }),
      ),
    ).toThrow("result.terminal.connected");
    expect(() =>
      decodeTerminalRead(
        success({
          terminal: {
            handle: "terminal",
            status: "running",
            tail: [3],
          },
        }),
      ),
    ).toThrow("result.terminal.tail");
    expect(() => decodeTerminalClose(success({ close: {} }))).toThrow(
      "result.close.handle",
    );
  });

  it("extracts structured failures without treating the envelope ID as evidence", () => {
    expect(
      decodeOrcaFailure({
        id: "rpc-failure-id",
        ok: false,
        error: {
          code: "terminal_handle_stale",
          message: "terminal_handle_stale",
          data: { recovery: ["terminal-list"] },
        },
      }),
    ).toEqual({
      code: "terminal_handle_stale",
      message: "terminal_handle_stale",
      details: { recovery: ["terminal-list"] },
    });
    expect(
      decodeOrcaProcessFailure(
        success({
          state: "failed",
          failedStage: "terminal_send",
          lastError: "Terminal rejected input",
        }),
      ),
    ).toEqual({
      code: "terminal_send",
      message: "Terminal rejected input",
    });
  });
});
