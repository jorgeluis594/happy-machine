# Orca JSON Contract Hardening Design

## Goal

Make the Orca outbound adapter consume current machine-readable Orca responses
without confusing RPC envelope identifiers with Run, Task, Dispatch, or terminal
identifiers. Failures must retain their raw logs and expose the structured Orca
diagnostic instead of an empty `Orca command failed` message.

The triggering incident used a successful `task-create` response shaped as an
RPC envelope. The envelope's top-level `id` identified the request, while the
created Task lived at `result.task.id`. Recursive key lookup selected the request
ID, passed it to `worker-start`, and produced `task_not_found`. Orca wrote that
structured error to stdout, while the adapter formatted only stderr.

## Scope

The correction covers every Orca response consumed by `OrcaTaskExecutor`:

- `run-create`, `task-create`, and `worker-start` during launch;
- `task-list` and `dispatch-show` during provenance recovery;
- `worker-show` during reconciliation;
- `check` completion, question, and escalation messages;
- nonzero process exits, unsuccessful RPC envelopes, invalid JSON, and missing
  required fields.

The task-executor port, durable `run.json` shape, workflow semantics, retry
policy, and result-file contract remain unchanged. The change adds no runtime
dependency and does not attempt to make arbitrary undocumented Orca payloads
valid.

## Approaches Considered

### Command-specific decoders without a new dependency — selected

Introduce a small Orca response decoder module with one operation-specific
decoder per response. Each decoder accepts only explicit, documented paths and
returns the technology-specific values needed by the adapter. This makes schema
drift visible at the boundary and prevents unrelated `id`, `state`, or `status`
fields from being selected.

### More selective recursive lookup

Keep the current recursive search but rank nested keys or ignore the first
top-level `id`. This is a small patch, but remains ambiguous for task lists,
dispatch inspection, lifecycle states, and messages. A new envelope field could
silently reintroduce the same class of bug.

### Runtime schemas through a validation library

Add a schema library and model each Orca result exhaustively. This provides
strong validation but adds a dependency and more maintenance than this adapter
boundary needs. Small explicit decoders provide the required safety while
remaining easy to audit.

## Architecture

Add an Orca-only response module beside the executor. It has three
responsibilities:

1. Recognize an RPC envelope and distinguish success from structured failure.
2. Decode command-specific result objects into small internal records.
3. Decode the message collection returned by `check` into completion and
   intervention observations.

`OrcaTaskExecutor` continues to own command sequencing, cancellation, waiting,
and translation into the technology-independent task-executor port. It no
longer performs recursive resource-ID or lifecycle-state searches.

The internal decoder surface is:

- `decodeRunCreate(value) -> { runId }`
- `decodeTaskCreate(value) -> { taskId }`
- `decodeWorkerStart(value) -> { taskId, dispatchId, terminalHandle?, state }`
- `decodeTaskList(value) -> TaskCandidate[]`
- `decodeDispatchShow(value) -> DispatchObservation | null`
- `decodeWorkerShow(value) -> WorkerObservation`
- `decodeCheck(value) -> { completion?, events }`
- `decodeOrcaFailure(value) -> { code?, message, details? } | null`

The decoders return plain internal values or throw an adapter-specific response
error that names the operation and missing or invalid field. They never include
the complete task specification in the exception message.

## RPC Envelope and Compatibility Rules

Current Orca JSON output is an RPC envelope with a request-level `id`, `ok`, and
either `result` or `error`. The top-level `id` is never a resource identifier.

The decoders use the following current contracts:

- Run creation: `result.run.id`.
- Task creation: `result.task.id`.
- Task listing: task records in `result.tasks`, with each Task ID at `task.id`.
- Worker start: `result.taskId`, `result.dispatchId`, `result.state`, and
  optional `result.agentTerminalHandle`.
- Dispatch inspection: `result.dispatch.id`, `result.dispatch.task_id`,
  `result.dispatch.worker_state`, and optional
  `result.dispatch.agent_terminal_handle`.
- Worker inspection: `result.dispatch.id`, `result.dispatch.task_id`,
  `result.worker.state`, and optional `result.worker.agent_terminal_handle`.
- Check: only entries in `result.messages` can produce completion, question, or
  escalation observations.

The controlled fake is updated to use the current RPC envelope. The production
decoder does not accept an unwrapped test-only payload. Any future compatibility
alias must correspond to a verified Orca contract, be declared next to the
relevant decoder, and have its own fixture. No decoder may fall back to a
recursive generic `id`, `state`, `status`, or `handle` search.

An exit-zero response with `ok: false` is an executor error. A success envelope
without the operation's required result fields is also an executor error; the
adapter must not guess an identifier or continue to the next mutation.

## Launch Flow

1. Persist the stable Happy Machine attempt identity as today.
2. Run `run-create`, decode only the Run creation contract, and retain its raw
   stdout and stderr.
3. Run `task-create`, decode only the Task creation contract, and retain its raw
   output.
4. Start the worker with the decoded Task ID.
5. Decode the worker-start receipt and verify that its returned Task ID, when
   present, equals the Task ID used for the command.
6. Persist the decoded Orca Run, Task, Dispatch, and optional terminal references
   through the existing `onStarted` callback.
7. Wait for structured `check` messages. A completion is accepted only when it
   is a `worker_done` message for the persisted Dispatch ID with an explicit
   terminal outcome.

The adapter does not infer success from arbitrary serialized text containing
`worker_done`, `succeeded`, or a Dispatch ID.

## Recovery and Reconciliation

Recovery reads only the Task collection returned by `task-list`. It examines
each Task's specification for the stable attempt identity and returns that
Task's own ID. It must not test the serialized root envelope first, because the
root naturally contains every nested specification.

`dispatch-show` is then decoded using its explicit dispatch and worker fields.
Missing dispatch context maps to the existing safe recovery result. Known Orca
worker states continue to map to `active`, `completed`, `failed`,
`start_unknown`, or `stop_unknown` exactly as required by the current port.
Unknown or malformed states map to uncertainty rather than permission to launch
duplicate work.

Reconciliation reads the worker state only from the worker object returned by
`worker-show`. It never accepts another nested object's `state` value.

## Error Reporting

The process runner always retains complete stdout and stderr in the attempt
logs. When an Orca command fails, the user-facing diagnostic follows this
priority:

1. `error.code` and `error.message` from a valid unsuccessful JSON envelope in
   stdout;
2. nonempty stderr text;
3. nonempty stdout text when it is not a structured Orca error;
4. the command operation and process exit code.

The formatted error names only the safe operation, such as `worker-start`, not
the complete argument list. This prevents the embedded task contract from being
duplicated into status or history while preserving it in the existing durable
logs where applicable.

Invalid JSON on an exit-zero command reports that the named operation returned
invalid JSON. Missing fields report the expected field and operation. Structured
Orca details and recovery guidance remain in stdout logs even when the concise
message uses only the code and message.

## Message Decoding

`check` decoding walks the explicit message collection, not every object in the
RPC response. It accepts the documented intervention types and their resolved
forms, preserves their own identifiers and messages, and deduplicates repeated
delivery of the same event as today.

A `worker_done` message settles only the matching Dispatch. Questions and
escalations remain observable events and never control workflow routing.
Unknown message types are ignored. Malformed recognized messages are retained
in raw logs but cannot fabricate completion or an intervention event.

## Testing

Update the fake Orca executable so its default JSON mirrors the current RPC
envelope and deliberately gives every envelope a request ID different from the
resource ID. This turns the original failure into a permanent regression test.

Focused adapter coverage must prove:

- launch uses `result.task.id`, never the envelope ID;
- Run, Task, Dispatch, and terminal references are persisted from their own
  command contracts;
- the worker-start Task ID must match the created Task when Orca returns it;
- task-list recovery finds the nested matching Task without selecting the
  envelope;
- dispatch-show and worker-show read the intended worker state;
- only a matching structured `worker_done` completes the wait;
- questions, escalations, and their resolutions are decoded and deduplicated;
- `ok: false` at exit zero fails safely;
- a nonzero command with a JSON error in stdout exposes its code and message;
- stderr and plain-stdout fallbacks remain useful;
- invalid JSON and missing required fields fail with operation-specific errors;
- raw stdout and stderr remain attached to `TaskExecutorError` in every failure
  path;
- unsupported unwrapped test payloads fail instead of bypassing envelope
  validation.

The existing execute, recovery, cancellation, timeout, detach/resume, status,
and history tests then run as regression coverage. The implementation is
complete only when focused Orca tests and the full automated suite pass.

## Success Criteria

- A real Orca envelope cannot cause a request ID to be used as a resource ID.
- Every adapter command either yields a validated internal result or fails
  before the next side effect.
- Recovery and reconciliation cannot select unrelated nested identifiers or
  lifecycle states.
- Structured Orca failures are visible in the terminal and remain fully
  attributable in durable logs.
- Existing workflow, persistence, retry, cancellation, and routing contracts do
  not change.
