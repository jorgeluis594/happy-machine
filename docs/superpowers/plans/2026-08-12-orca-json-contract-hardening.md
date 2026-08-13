# Orca JSON Contract Hardening Implementation Plan

## Goal

Implement
`docs/superpowers/specs/2026-08-12-orca-json-contract-hardening-design.md`
so every Orca response is decoded through an operation-specific contract,
request envelope IDs can never become resource references, and structured Orca
failures remain visible in both the terminal diagnostic and durable attempt
logs.

## 1. Add an operation-specific Orca response boundary

- Add an Orca-only response module beside `orca-task-executor.ts` with helpers
  for safe object, string, array, and RPC-envelope access.
- Define decoders for run creation, task creation, worker start, task listing,
  dispatch inspection, worker inspection, and check messages.
- Require the current `{ id, ok, result | error }` envelope and explicit result
  paths from the design; never recurse for a generic resource ID, state, status,
  or handle.
- Model malformed success payloads and unsuccessful envelopes as typed internal
  response errors containing the safe operation name and expected field.
- Add focused decoder tests with conflicting request/resource IDs, missing
  fields, wrong field types, `ok: false`, unknown messages, and malformed
  recognized messages.

## 2. Replace heuristic launch and recovery parsing

- Update launch to decode `run-create`, `task-create`, and `worker-start`
  receipts through their dedicated decoders.
- Verify the worker-start Task ID, when returned, matches the Task passed to the
  command before persisting executor references.
- Replace root-envelope provenance search with iteration over decoded
  `result.tasks`; match the stable Happy Machine attempt identity only inside
  each Task specification.
- Decode `dispatch-show` into the existing recovery observations and map unknown
  or malformed worker states to safe uncertainty without allowing duplicate
  launch.
- Decode `worker-show` from its explicit dispatch and worker objects for
  reconciliation.
- Remove resource and lifecycle uses of the recursive `findString` and
  root-first `findObjectContaining` helpers once no caller needs them.

## 3. Make completion and intervention handling structural

- Decode only `result.messages` returned by `orchestration check`.
- Accept completion only from a `worker_done` message whose Dispatch ID matches
  the persisted Dispatch and whose outcome is explicitly terminal.
- Preserve question and escalation observation/resolution behavior while using
  each message's own typed ID, status, and text fields.
- Keep duplicate delivery idempotent through the existing observed-event map.
- Add adapter tests for mismatched completion, misleading envelope text,
  repeated events, resolved interventions, unknown message types, and malformed
  known messages.

## 4. Improve process and RPC failure diagnostics

- Pass a safe operation label into the process runner separately from the full
  argument array.
- Always attach accumulated stdout and stderr to `TaskExecutorError`.
- On nonzero exit, parse an unsuccessful JSON envelope from stdout first, then
  fall back to stderr, plain stdout, and the exit code in that order.
- Treat exit-zero `ok: false`, invalid JSON, and missing required success fields
  as executor failures before the next side effect.
- Keep the task specification and full command arguments out of the concise
  failure message while leaving raw output in durable logs.
- Add tests for structured stdout failures, stderr failures, plain stdout,
  invalid JSON, exit-zero unsuccessful envelopes, and errors accumulated after
  earlier successful Orca calls.

## 5. Upgrade the controlled Orca fixture and integration coverage

- Change `tests/fixtures/fake-orca.mjs` to emit current RPC envelopes by default
  with deliberately different request, Run, Task, Dispatch, and message IDs.
- Add fixture controls for unsuccessful envelopes, nonzero structured errors,
  malformed results, alternate worker states, and message sequences without
  introducing arbitrary sleeps.
- Update existing executor, execute, recovery, cancellation, timeout,
  detach/resume, status, and history expectations to read the current envelope
  shape while preserving their behavioral assertions.
- Add an end-to-end regression reproducing the original failure shape and prove
  `worker-start` receives the created Task resource ID rather than the request
  envelope ID.
- Prove a structured Orca failure appears in the persisted run failure and its
  complete stdout remains in the attempt logs.

## 6. Validate the complete correction

- Run the focused response-decoder and Orca executor tests while iterating.
- Run the execute, recovery, cancellation, timeout, detach/resume, status, and
  history suites affected by the shared fake Orca fixture.
- Run formatting, linting, typechecking, and the full automated test suite using
  the repository's existing package scripts.
- Inspect the final diff for accidental port, domain, persistence, workflow, or
  routing changes.
- Confirm every success criterion in the design has a direct automated test and
  commit only the related implementation and test files.

