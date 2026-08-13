# Happy Machine-Owned Terminal Prompts Implementation Plan

## Objective

Replace the Orca orchestration-backed executor with a terminal-only adapter. Happy Machine supplies Codex developer instructions, sends the configured user prompt byte-for-byte, monitors `result.json`, and uses Orca only to create, send to, read, inspect, and close terminals.

## 1. Generalize external execution identity

Files:

- `src/domain/execution/run.ts`
- `src/ports/diagnostics.ts`
- `src/ports/task-executor.ts`
- application event and presenter modules that expose executor references

Changes:

- Add a technology-neutral `executionId` for new attempts.
- Retain optional legacy Run, Task, Dispatch, and terminal fields so existing durable JSON remains readable.
- Correlate new events and diagnostics with `executionId`; retain Dispatch fields only when rendering legacy data.
- Pass the result path into recovery so the executor can distinguish completion from terminal liveness.

Validation:

- Typecheck application and domain code.
- Extend snapshot/presenter tests for terminal-only and legacy references.

## 2. Replace Orca response contracts

Files:

- `src/infrastructure/outbound/task-executor/orca/orca-response.ts`
- `tests/orca-response.test.ts`

Changes:

- Keep the existing Orca success and process-failure envelope validation.
- Decode `terminal create`, `terminal send`, `terminal show`, `terminal read`, and `terminal close` responses.
- Validate terminal handles, accepted sends, running/stopped states, transcript cursors, and close receipts.
- Remove runtime use of Run, Task, Dispatch, Check, and Worker decoders.

Validation:

- Focused decoder tests for valid, invalid, mismatched, and unsuccessful responses.

## 3. Rebuild the Orca executor around terminals

Files:

- `src/infrastructure/outbound/task-executor/orca/orca-task-executor.ts`

Changes:

- Build Codex with the configured model, no sandbox, and a safely shell-quoted `developer_instructions` value containing Happy Machine instructions and result contract.
- Create and focus the terminal, then persist `executionId` immediately through `onStarted`.
- Wait exactly 8,000 cancelable milliseconds.
- Send `launch.prompt` unchanged with `terminal send --text ... --enter`.
- Poll the assigned result path and terminal state until the result exists or the terminal stops.
- Read terminal output only when diagnostics are enabled.
- Cancel and reconcile with `terminal close` and `terminal show`.
- Recover terminal-only attempts from the persisted handle and result path without Orca orchestration.
- Treat legacy references without a usable terminal handle as unknown rather than invoking legacy orchestration.

Validation:

- Focused executor tests for ordering, exact prompt text, developer instructions, escaping, cleanup, monitoring, diagnostics, recovery, reconciliation, and cancellation.
- Assert that no command starts with `orca orchestration` and no `terminal wait` call occurs.

## 4. Update the fake Orca integration harness

Files:

- `tests/fixtures/fake-orca.mjs`
- integration tests that inspect fake contracts or orchestration calls

Changes:

- Model terminal create/send/show/read/close envelopes.
- Record the Codex command and exact sent prompt separately.
- Simulate agent output and `result.json` creation on terminal send.
- Provide controllable running, stopped, stale, failure, and blocked states.
- Replace assertions against Task specifications and Dispatch calls with assertions against developer instructions and terminal calls.

Validation:

- Run focused Orca tests and workflow execution/recovery/cancellation tests.

## 5. Complete repository validation and delivery

Changes:

- Remove dead orchestration-specific adapter code and tests after terminal coverage is equivalent.
- Update durable memory to supersede the previous Dispatch lifecycle decision.
- Build the globally linked package.
- Run a minimal CLI workflow and inspect the terminal call record to confirm the user prompt is unchanged and no orchestration command was issued.

Required commands:

- `npm run lint:fix`
- `npm test`
- `npm run typecheck`
- `npm run build`
- `happy-machine --help`

Commit only related source, tests, plan, and documentation. Preserve unrelated untracked files.
