import { describe, expect, it } from "vitest";
import {
  decodeCheck,
  decodeDispatch,
  decodeDispatchShow,
  decodeOrcaFailure,
  decodeOrcaProcessFailure,
  decodeRunCreate,
  decodeTaskCreate,
  decodeTerminalCreate,
  decodeTaskList,
  decodeWorkerShow,
  decodeWorkerStart,
  decodeWorkerRead,
} from "../src/infrastructure/outbound/task-executor/orca/orca-response.js";

const success = (result: unknown, id = "rpc-envelope-id") => ({
  id,
  ok: true,
  result,
  _meta: { runtimeId: "runtime" },
});

describe("Orca RPC response decoding", () => {
  it("decodes verified transcript pages and terminal fallback pages", () => {
    expect(
      decodeWorkerRead(
        success({
          source: "transcript",
          cursor: "opaque:2",
          transcript: {
            messages: [
              {
                role: "assistant",
                blocks: [
                  { type: "text", text: "working" },
                  { type: "tool-call", name: "rg", input: { pattern: "x" } },
                  { type: "tool-result", output: "found", isError: false },
                  { type: "image", url: "secret" },
                ],
              },
            ],
          },
        }),
      ),
    ).toMatchObject({
      source: "transcript",
      cursor: "opaque:2",
      terminalLines: [],
    });
    expect(
      decodeWorkerRead(
        success({
          source: "terminal",
          cursor: 7,
          fallbackReason: { code: "session_unverified" },
          terminal: { tail: ["line"] },
        }),
      ),
    ).toEqual({
      source: "terminal",
      cursor: 7,
      fallbackReason: "session_unverified",
      messages: [],
      terminalLines: ["line"],
    });
  });

  it("rejects malformed worker-read pages", () => {
    expect(() =>
      decodeWorkerRead(
        success({ source: "terminal", terminal: { tail: [3] } }),
      ),
    ).toThrow("terminal.tail");
    expect(() =>
      decodeWorkerRead(
        success({ source: "transcript", transcript: { messages: "bad" } }),
      ),
    ).toThrow("transcript.messages");
  });
  it("reads resource IDs without selecting the envelope ID", () => {
    expect(
      decodeRunCreate(success({ run: { id: "run-resource-id" } })),
    ).toEqual({ runId: "run-resource-id" });
    expect(
      decodeTaskCreate(success({ task: { id: "task-resource-id" } })),
    ).toEqual({ taskId: "task-resource-id" });
    expect(
      decodeTerminalCreate(
        success({ terminal: { handle: "terminal-resource-id" } }),
      ),
    ).toEqual({ terminalHandle: "terminal-resource-id" });
    expect(
      decodeDispatch(
        success({
          dispatch: {
            task_id: "task-resource-id",
            id: "dispatch-resource-id",
            status: "active",
          },
        }),
      ),
    ).toEqual({
      taskId: "task-resource-id",
      dispatchId: "dispatch-resource-id",
      status: "active",
    });
    expect(
      decodeWorkerStart(
        success({
          taskId: "task-resource-id",
          dispatchId: "dispatch-resource-id",
          agentTerminalHandle: "terminal-resource-id",
          state: "ready",
        }),
      ),
    ).toEqual({
      taskId: "task-resource-id",
      dispatchId: "dispatch-resource-id",
      terminalHandle: "terminal-resource-id",
      state: "ready",
    });
  });

  it("rejects unwrapped and malformed success payloads", () => {
    expect(() => decodeRunCreate({ run: { id: "run" } })).toThrow(
      "Orca run-create response expected an RPC envelope with ok=true",
    );
    expect(() => decodeTaskCreate(success({ task: {} }))).toThrow(
      "result.task.id",
    );
    expect(() => decodeTerminalCreate(success({ terminal: {} }))).toThrow(
      "result.terminal.handle",
    );
    expect(() =>
      decodeDispatch(
        success({ dispatch: { task_id: "task", id: "", status: "active" } }),
      ),
    ).toThrow("result.dispatch.id");
    expect(() =>
      decodeWorkerStart(
        success({
          taskId: "task",
          dispatchId: "dispatch",
          state: "mystery",
        }),
      ),
    ).toThrow("result.state to contain a known worker state");
  });

  it("finds recovery identity only inside decoded task specifications", () => {
    expect(
      decodeTaskList(
        success({
          tasks: [
            { id: "unrelated", spec: "plain text" },
            {
              id: "matching-task",
              spec: JSON.stringify({
                happyMachineAttemptIdentity: "run:state:1:task:1",
              }),
            },
          ],
        }),
      ),
    ).toEqual([
      { taskId: "unrelated" },
      {
        taskId: "matching-task",
        attemptIdentity: "run:state:1:task:1",
      },
    ]);
  });

  it("decodes dispatch and worker observations from their explicit objects", () => {
    expect(
      decodeDispatchShow(
        success({
          runId: "run-resource-id",
          dispatch: {
            id: "dispatch-resource-id",
            task_id: "task-resource-id",
            worker_state: "ready",
            agent_terminal_handle: "terminal-resource-id",
          },
        }),
      ),
    ).toEqual({
      runId: "run-resource-id",
      dispatchId: "dispatch-resource-id",
      taskId: "task-resource-id",
      workerState: "ready",
      terminalHandle: "terminal-resource-id",
    });
    expect(decodeDispatchShow(success({ dispatch: null }))).toBeNull();
    expect(
      decodeWorkerShow(
        success({
          dispatch: {
            id: "dispatch-resource-id",
            task_id: "task-resource-id",
          },
          worker: {
            state: "stopped",
            agent_terminal_handle: "terminal-resource-id",
          },
        }),
      ),
    ).toEqual({
      dispatchId: "dispatch-resource-id",
      taskId: "task-resource-id",
      workerState: "stopped",
      terminalHandle: "terminal-resource-id",
    });
  });

  it("accepts only a structured completion for the expected dispatch", () => {
    const matching = decodeCheck(
      success({
        messages: [
          {
            id: "worker-message",
            type: "worker_done",
            payload: JSON.stringify({
              dispatchId: "expected-dispatch",
              outcome: "succeeded",
            }),
          },
        ],
        misleading: "worker_done succeeded other-dispatch",
      }),
      "expected-dispatch",
    );
    expect(matching.completion).toEqual({
      dispatchId: "expected-dispatch",
      outcome: "succeeded",
    });

    const mismatched = decodeCheck(
      success({
        messages: [
          {
            id: "worker-message",
            type: "worker_done",
            payload: JSON.stringify({
              dispatchId: "other-dispatch",
              outcome: "succeeded",
            }),
          },
        ],
        misleading: "expected-dispatch worker_done succeeded",
      }),
      "expected-dispatch",
    );
    expect(mismatched.completion).toBeUndefined();
  });

  it("decodes and deduplicates structured intervention messages", () => {
    const observation = decodeCheck(
      success({
        messages: [
          {
            id: "question-1",
            type: "question",
            subject: "Approve?",
          },
          {
            id: "resolution-message",
            type: "question_resolved",
            payload: JSON.stringify({
              questionId: "question-1",
              status: "answered",
            }),
          },
          {
            id: "escalation-1",
            type: "escalation",
            body: "Review required",
          },
          {
            id: "malformed-worker",
            type: "worker_done",
            payload: "not json",
          },
        ],
      }),
      "dispatch",
    );
    expect(observation.completion).toBeUndefined();
    expect(observation.events).toMatchObject([
      { id: "question-1", type: "question", status: "resolved" },
      {
        id: "escalation-1",
        type: "escalation",
        status: "pending",
        message: "Review required",
      },
    ]);
  });

  it("extracts structured failures without treating the envelope ID as evidence", () => {
    expect(
      decodeOrcaFailure({
        id: "rpc-failure-id",
        ok: false,
        error: {
          code: "task_not_found",
          message: "Task rpc-failure-id was not found",
          data: { recovery: ["task-list"] },
        },
      }),
    ).toEqual({
      code: "task_not_found",
      message: "Task rpc-failure-id was not found",
      details: { recovery: ["task-list"] },
    });
    expect(
      decodeOrcaProcessFailure(
        success({
          state: "failed",
          failedStage: "agent_launch",
          lastError: "Agent did not become ready",
        }),
      ),
    ).toEqual({
      code: "agent_launch",
      message: "Agent did not become ready",
    });
  });
});
