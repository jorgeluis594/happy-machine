# Normal Routing and Document Exchange Design

## Scope

Implement Task 04 so a run can traverse two or more reachable normal agent states, route solely from the semantic outcome in `result.json`, and make explicitly declared Markdown documents durably available to later visits. Retries, cycles, parallel states, exhaustive result validation, crash recovery, and workspace source-control operations remain outside this change.

## Architecture

`ExecuteWorkflow` owns a sequential execution loop. It reads the effective workflow definition from the immutable run snapshot, enters one normal state at a time, launches that state's implicit task, validates the structured result, commits the result and documents, and only then resolves and enters the next target. Terminal targets are recognized only by the exact names `$succeeded` and `$failed`; names such as `succeeded`, `failed`, and `rejected` remain ordinary semantic outcomes.

The domain run record owns visits, attempts, transitions, and immutable document metadata. The repository port exposes technology-independent operations for preparing visit context, reading a declared result, and durably committing a successful attempt. The filesystem adapter owns paths, hashing, exclusive document publication, context rendering, and atomic replacement of `run.json`.

## State and Document Model

Each normal state has one stable implicit task ID derived from the state ID. A visit records its own monotonically increasing visit number, though Task 04 only follows forward transitions and therefore visits each state once.

Every committed document records:

- Producing state ID
- Visit number
- Task ID
- Declared document name
- Immutable internal provenance path
- Durable filesystem path
- SHA-256 digest

The internal path is `states/{state-id}/visits/{visit-number}/tasks/{task-id}/documents/{name}.md`. State, visit, and task segments isolate equal basenames, so later documents never overwrite earlier versions. Files are published with exclusive creation and are never modified afterward.

## Execution and Durability Flow

For each state, the application:

1. Creates the visit and its fresh immutable `context.md`.
2. Creates and persists the attempt before launch.
3. Executes using instructions, prompt, model, policies, and timeout from the snapshot's effective state definition.
4. Reads only `result.json` for the outcome and declared document paths.
5. Asks the repository to commit the declared Markdown files and updated run record.
6. Resolves the committed outcome to exactly one declared target.
7. Enters the next normal state or records the exact terminal target.

The commit operation stages document copies before publishing them to provenance paths and persists the attempt outcome, document index, and transition before returning. `ExecuteWorkflow` cannot create or launch the next visit until that operation succeeds. If document or run persistence fails, execution stops and the next state is never entered.

## Visit Context

Each visit receives a newly created `context.md` containing:

- Every immutable input from the run snapshot
- Every document committed by earlier successful attempts
- For each item, its hash, provenance/internal path, and durable path

The context is created once with exclusive filesystem semantics and does not change during the visit. Documents produced by the current visit do not appear until a later visit. Undeclared modifications in the project workspace are neither scanned nor indexed and cannot affect routing.

## Error Handling

An unknown outcome, invalid result, invalid document, executor failure, or persistence failure marks the active attempt and run as technically failed using the existing failure path. A valid negative business result is not a technical failure: its configured target controls termination. Logs and Markdown contents are retained as data only and never inspected for routing.

## Testing

End-to-end coverage will exercise every branch of a workflow with at least three states, including approved and needs-revision paths. Additional tests will prove:

- A negative business outcome can target `$succeeded` while remaining the last outcome.
- Ordinary outcomes named `succeeded` and `failed` route normally.
- Multiple documents and repeated basenames remain distinct and appear in later contexts.
- Every forward visit receives a new immutable context snapshot.
- A persistence failure prevents the next state from launching.
- Undeclared project-workspace edits are absent from context and do not affect routing.
- Misleading outcome names in logs or Markdown never override `result.json`.

## Deliberate Constraints

The design uses an iterative application loop rather than repository-driven routing or recursive execution. This keeps orchestration in the application layer, persistence mechanics in infrastructure, and transition semantics in the domain model while leaving future retry, cycle, and parallel-state work independently extensible.
