# Parallel States with an All-Settled Join

## Goal

Implement Task 07 so a parallel state creates every declared task, executes
them with bounded concurrency and independent retry policies, waits for every
task to settle, and commits one engine-calculated aggregate transition. The
join preserves successful documents and structured failure evidence without
exposing sibling output during fan-out.

## Domain Model

State visits become a discriminated union. A normal visit owns one `task`; a
parallel visit owns an ordered collection of `tasks`. Both retain the state ID,
visit number, immutable context path, and eventual transition. Each parallel
task record owns its attempts and, once settled, its final `succeeded` or
`failed` status plus its final failure when present.

The aggregate outcome exists only on the parallel visit. The engine calculates
`succeeded` when every task succeeded and `failed` otherwise. Agent prose,
documents, and logs never select or override that result.

## Visit Setup and Frozen Context

On entry to a parallel state, the controller creates one durable task record
for every task definition in definition order. It then prepares and persists
the visit context before launching any task. Every attempt for every sibling
uses that same context path and content.

Successful sibling documents may be copied into durable document storage as
their tasks settle, but they are not appended to the run's committed document
index until the join is ready to commit. Therefore a queued sibling starting
after a fast sibling still receives the original context snapshot and cannot
discover the sibling document through workflow context.

## Scheduling and Attempts

The application use case runs a bounded worker pool whose size is the state's
validated `effectiveMaxConcurrency`, already calculated as the smaller of
`max_concurrency` and task count. Workers claim tasks in deterministic
definition order. A settled task frees one slot, allowing the next queued task
to start regardless of whether the prior task succeeded or failed.

Each task runs the existing attempt lifecycle independently: unique attempt
identity and control paths, its own effective timeout, retry budget and delay,
Orca references, logs, outputs, and final failure. A valid parallel result may
declare only `succeeded` or `failed`. `failed` is recorded as an attempt failure
and retried; its optional structured error is retained as the diagnostic basis
for that failure. Successful results stage their declared Markdown documents.

An execution whose external stop cannot be reconciled remains unsafe. This is
an engine-level inability to calculate a trustworthy join, so the controller
does not fabricate an aggregate `failed` result or follow the state's failed
transition. Already running work is still allowed to settle before the
controller reports the engine failure; no sibling is cancelled merely because
another task failed.

## Join Commit and Transition

After all tasks settle, the controller clones the run and applies the complete
join in one repository save:

- every task's final status, attempts, final failure or successful outcome;
- all documents staged by successful tasks, with task-specific provenance;
- aggregate `succeeded` or `failed` and its configured target;
- events describing task settlement and the committed aggregate transition.

The repository save is the persistence boundary. If staging, aggregate
calculation, or that save fails, the run is recorded as an engine failure when
possible and the workflow's aggregate transition is not followed. The next
state is entered only after the joined run was saved successfully.

## Downstream Context

Context generation indexes all documents committed by successful siblings. For
each completed parallel visit it also renders every task in definition order
with final status, attempt count, final error summary when present, attempt
audit paths, executor references when available, and available workspace
metadata. This structured section lets a recovery state explain the whole join
without parsing free-form logs.

Direct mode continues to give all siblings the same project workspace, as
required until Task 13. Control workspaces remain task- and attempt-specific,
so identical output basenames cannot collide and retain separate provenance.

## Architecture

The domain execution model owns visit/task status and aggregate invariants. The
application use case owns bounded scheduling, independent attempt orchestration,
all-settled coordination, and transition ordering. The run-repository port owns
technology-independent persistence operations; its filesystem adapter owns
context rendering, isolated path construction, document copying, and atomic
`run.json` replacement. No infrastructure representation crosses inward.

## Testing

Deterministic application and filesystem tests cover:

- successful and partially failed end-to-end joins;
- maximum active concurrency, effective limits, continued scheduling after a
  failure, and waiting for the last task;
- one frozen context for fast, delayed, and retried siblings;
- independent retries, declared `failed` retry behavior, and per-task timeouts;
- complete downstream documents and structured task summaries;
- aggregate calculation independent of logs and document prose;
- injected aggregate-save failure bypassing the configured failed transition;
- shared direct project workspace with isolated task control workspaces,
  results, logs, documents, and provenance.

The final verification runs formatting/lint fixes, the complete test suite, and
TypeScript type checking, followed by an explicit audit against all eleven
acceptance criteria and every required test in Task 07.
