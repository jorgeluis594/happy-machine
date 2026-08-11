# Task 12: Cancel runs durably and irreversibly

## Objective

Allow a user to explicitly cancel a run, safely stop all external work, and preserve the evidence generated up to that point.

## Functional value

Users have an unambiguous mechanism for stopping a workflow without confusing cancellation with failure or detach. Cancellation survives a crash of the process performing it and never accidentally resumes normal scheduling.

## Dependencies

- Task 11.

## Scope

- Expose happy-machine cancel RUN_ID.
- Treat cancel as an explicit, durable, and irreversible request.
- Persist the request before asking for any external cancellation.
- Stop scheduling new states, tasks, and retries immediately after accepting the request.
- Move the run to canceling while active work remains to be stopped or reconciled.
- Request cancellation of every active Orca execution and preserve its references.
- Reconcile each execution until its final state is known or uncertainty is recorded safely.
- Preserve history, snapshots, committed documents, audit outputs, logs, source changes, and worktrees.
- Move the run to canceled only after the required reconciliation is complete.
- Make a canceled run terminal and not resumable.
- If the controller disappears during canceling, preserve the durable request and make a later invocation continue cancellation instead of resuming scheduling.
- If cancel is invoked for an already-terminal run, report its current status without changing it.
- Record the request, status changes, per-execution actions, and terminal completion.
- Keep cancellation separate from outcomes and failures; do not execute a transition to reach canceled.
- Apply the contract's exit codes to attached commands that observe canceled.

## Out of scope

- Rolling back source changes.
- Deleting documents, logs, branches, commits, or worktrees.
- Resuming a canceled run.
- Treating Ctrl+C as cancellation.
- Routing cancellation through outcomes or on_failure.
- Worktree cleanup; that belongs to Task 14.

## Acceptance criteria

1. **Active cancellation:** Given a run with active Orca executions and queued tasks, when cancel runs, then the request is persisted, no queued task starts, active executions are canceled, and the run ends as canceled after reconciliation.
2. **Durable ordering:** Given process failure immediately after cancel is accepted, when recovery occurs, then storage already contains the request and no controller returns to normal scheduling.
3. **Interruption during canceling:** Given that the process dies while stopping several tasks, when cancel runs again, then pending reconciliation continues without duplicate requests or revived tasks.
4. **Evidence preserved:** Given a run with successful documents, logs, failed outputs, and source changes, when it ends as canceled, then all evidence remains accessible and unchanged.
5. **No outcome:** Given completed cancellation, when history is queried, then canceled status and cancellation events exist, but no outcome or transition was fabricated to represent cancellation.
6. **Resume rejected:** Given a canceled run, when resume is invoked, then it is rejected without acquiring a lease or launching work.
7. **Cancel after succeeded:** Given a succeeded run, when cancel is invoked, then succeeded is reported and history, terminal reason, and documents do not change.
8. **Cancel after failed or canceled:** Given either terminal status, when cancel is invoked, then the existing status is reported idempotently.
9. **Observable state:** Given a run in canceling, when status runs, then it shows canceling and the cancellation or reconciliation state of every external execution.
10. **Exit code:** Given an attached execute or resume process that observes cancellation complete, when it exits, then it returns code 2.

## Required tests

- End-to-end test with several active and queued Orca tasks.
- Fault injection immediately after persisting the request and during reconciliation.
- Idempotency tests for every terminal status.
- Test preserving documents, audit material, logs, and project workspace.
- Combined test of cancel, status, history, and resume rejection.

## Traceability

- PRODUCT.md: Invariants 5.11–5.12; Sections 18.3, 20, 21.1, 21.5, 22.1, 22.5, 23.6, and 24.
- Normative scenario: 25.17.

## Definition of done

- The cancellation request survives a crash at any point in the process.
- No task or retry can begin after durable acceptance.
- Canceled is terminal, observable, nonrouteable, and not resumable.
- All evidence preceding cancellation remains accessible.
