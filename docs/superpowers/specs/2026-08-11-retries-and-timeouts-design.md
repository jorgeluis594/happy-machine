# Retries and Timeouts Design

## Scope

Implement Task 06 for normal agent states. A task may make a bounded number of attempts, including its initial attempt, and may recover from every retryable failure defined by PRODUCT.md Section 16.1. Retries remain within one state visit, reuse its immutable inputs, and never overlap an earlier external execution.

Parallel-state retries, workflow-wide limits, detached-controller reconciliation, and project-workspace rollback remain outside this change.

## Architecture

The application use case owns retry orchestration. It creates attempts, persists lifecycle events, enforces deadlines and delays through injected time dependencies, asks the executor port to cancel and reconcile timed-out work, validates results through the run repository, and commits exactly one successful transition.

The domain model owns typed attempt failures and expanded attempt lifecycle state. The task executor port exposes technology-independent launch, cancellation, and reconciliation contracts. The Orca adapter maps Orca commands and responses to those port contracts. The filesystem run repository continues to create attempt-specific control and output paths and the single visit-level context snapshot.

## Attempt Lifecycle

For each normal-state visit, the controller performs at most the effective `max_attempts` total attempts. Attempt numbers begin at one and are part of the persisted identity.

Before launch, the controller persists a new attempt in `launching` state and creates its unique control workspace, output directory, result path, and logs. The launch always receives the visit's existing `context.md`, the snapshotted instructions and prompt, the selected model, and the current attempt number.

When Orca starts work, the controller persists the executor references and changes the attempt to `running`. A terminal executor success is not sufficient by itself: the result and documents must also validate before the attempt succeeds.

Every retryable failure is converted to a typed `{ code, message }` record, persisted on the attempt, and accompanied by an `attempt_failed` event. If the attempt budget is exhausted, the run fails with that last typed failure and retains the complete attempt history. Otherwise the controller records the retry decision and fixed delay, waits the complete effective `retry_delay`, and only then creates the next attempt.

## Retry Isolation and Stable Context

The visit and its `context.md` are created once. A retry never creates a visit or transition and cannot add failed-attempt files to the context. Instructions and prompt come from the same immutable definition snapshot for every attempt.

Each attempt uses a new directory beneath its attempt number. The repository creates only that attempt's empty output directory, so partial control outputs from an earlier attempt are not visible at the retry's assigned paths. Direct-mode project workspace changes remain untouched and visible because retries reuse the project workspace; they are never indexed as workflow documents unless a successful result declares valid Markdown documents from its assigned output area.

## Time and Cancellation

The application receives a clock and sleep capability so tests can advance time deterministically. It races external execution against the effective `attempt_timeout`.

When the deadline wins, the controller:

1. Persists `timing_out` and an `attempt_timing_out` event.
2. Requests cancellation through the executor port and persists the request.
3. Reconciles the execution until the executor reports `stopped`, `active`, or `unknown`.
4. Retries only after `stopped` is confirmed.

Reconciliation is bounded by one additional effective `attempt_timeout`. This reuses the existing policy and avoids adding configuration outside Task 06. While the executor reports `active`, the controller waits a short injected polling interval and asks again. An `unknown` result is also retried within that reconciliation window because Orca uncertainty may be transient. If neither state becomes `stopped` before the deadline, the attempt and run fail with `external_execution_uncertain`; no later attempt is created.

The execution promise is observed after timeout so a late rejection cannot become unhandled, but a late result cannot be committed or authorize a retry. The cancellation/reconciliation result is authoritative after timeout.

## Failure Codes

The application retains stable codes and human-readable messages for at least:

- `executor_failed`: Orca reports failure or the executor process ends without a successful completion.
- `result_missing_or_invalid`: `result.json` is absent or malformed.
- `outcome_invalid`: the result outcome is absent or not configured.
- `documents_invalid`: a declared document is missing, outside the output area, not Markdown, or otherwise invalid.
- `attempt_timeout`: the attempt exceeded its deadline and was subsequently confirmed stopped.
- `external_execution_uncertain`: cancellation could not be reconciled safely.

Repository validation failures use typed repository errors so the application does not classify failures by parsing display text. Executor failures likewise cross the port as typed failures.

## Persistence and Events

The run record stores each attempt's identity, number, status, paths, executor references, logs, typed failure, documents, and timeout reconciliation result. Ordered events make the following facts observable:

- attempt creation and launch;
- external start;
- failure code and message;
- timeout and cancellation request;
- each reconciliation observation;
- retry decision, delay start, and delay completion;
- successful attempt and committed transition;
- final run failure and last cause.

The event timestamps, together with explicit delay duration data, prove that the next launch did not precede the complete retry delay.

## Success Commit

Only a fully validated attempt stages documents. The existing clone-and-save logical commit is retained: the attempt outcome and documents, visit outcome and target, run document index, transition event, and terminal status are saved together. Failed-attempt outputs never enter that commit.

One successful attempt resolves one transition. Retries do not increment visit or transition counts; the transition event is emitted once after success.

## Testing

Focused tests use fake executors and a controlled clock to prove:

- every Section 16.1 normal-state retryable cause receives a typed failure and exhausts at exactly `max_attempts`;
- failure, failure, success commits only the third result and transitions once;
- attempts reuse identical context, instructions, and prompt while receiving unique clean paths;
- partial outputs remain isolated while project workspace changes persist;
- the complete fixed delay occurs before the next attempt is created;
- timeout requests cancellation and cannot retry before confirmed stop;
- active and unknown reconciliation states never overlap a retry and eventually fail safely when unresolved;
- two retries still produce one visit and one transition;
- every attempt retains its own identity, paths, logs, failure, and reconciliation evidence.

The final validation runs formatting/lint repair, the full test suite, and TypeScript type checking before the implementation commit.
