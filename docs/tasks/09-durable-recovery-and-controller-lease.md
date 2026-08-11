# Task 09: Recover durable runs after interruptions and enforce exclusive control

## Objective

Safely reconstruct a run after its controller process is lost and guarantee that at most one controller can mutate it at a time.

## Functional value

A process crash does not require starting over or risk executing the same external work twice. Durable storage explains what happened and allows continuation from the latest committed point.

## Dependencies

- Task 08.

## Scope

- Treat the project's durable store as the source of truth for runs, snapshots, visits, tasks, attempts, policies, executor provenance, documents, outcomes, transitions, errors, cancellation, leases, worktrees, and events.
- Make in-memory queues, concurrency counters, observed processes, and caches reconstructable.
- Persist an attempt with launching status and stable identity before invoking Orca.
- Associate that identity with Orca task, dispatch, and worker provenance that can be queried.
- Persist the external task ID, dispatch ID, and terminal handle as soon as available and before treating the attempt as running.
- After a crash between external launch and ID persistence, search by provenance before deciding whether to launch anything.
- Inspect existing Orca state before launch, retry, or recovery.
- Recover completed external results and apply the same validation and atomic commit as normal execution.
- Treat start_unknown and stop_unknown as uncertainty; reconcile or fail safely without duplication.
- Acquire and renew a durable controller lease whose effective period comes only from project configuration.
- Reject a second controller with run_already_controlled while the lease is valid, without mutating workflow state.
- Permit recovery after lease expiration without assuming expiration proves Orca work stopped.
- Record lease acquisition, renewal, loss, and recovery.
- Keep outcomes, transitions, documents, and events idempotent across repeated recovery.
- End the run as failed when storage is corrupt, state cannot be confirmed safely, or required workspace creation fails after run creation.

## Out of scope

- The explicit Ctrl+C experience and complete resume flow; those belong to Task 10.
- User-requested cancellation; that belongs to Task 12.
- High availability with multiple active controllers.
- Inferring that an external execution ended only because the lease expired.
- Automatic repair of corrupt durable storage.

## Acceptance criteria

1. **Durable source of truth:** Given that a process loses all in-memory state, when recovery starts from storage, then it reconstructs the visit, tasks, attempts, counters, and next action without relying on the previous process.
2. **Crash before launch:** Given a crash after persisting launching but before calling Orca, when recovery runs, then provenance search finds no execution and permits exactly one launch for that identity.
3. **Crash in the ID window:** Given that Orca launched the task but the process died before persisting its IDs, when recovery runs, then it finds the execution by stable identity and does not launch another.
4. **Crash after external completion:** Given that Orca finished but the local result was not committed, when recovery runs, then the result is retrieved, validated, and committed exactly once.
5. **Idempotent commit:** Given repeated recovery after a result was committed, when the same evidence is processed again, then documents, outcomes, transitions, and logical events are not duplicated.
6. **Controller exclusion:** Given a valid lease, when another process attempts to control the run, then it receives run_already_controlled and does not change status, tasks, attempts, or the current lease.
7. **Expired lease:** Given an expired lease and an active Orca execution, when another controller recovers the run, then it observes the existing execution rather than creating another.
8. **Renewal:** Given a controller active for longer than one lease period, when it operates normally, then it renews before expiration and preserves exclusive control.
9. **External uncertainty:** Given irreconcilable start_unknown or stop_unknown, when recovery runs, then the run fails safely and never duplicates execution.
10. **Uncommittable storage:** Given that a required durable operation cannot complete, when the engine attempts to advance, then it does not schedule the next work and the run either fails or remains recoverable from the last committed operation, without partially visible state.

## Required tests

- Fault injection at every boundary: before launch, after launch, before ID persistence, after external result, and during commit.
- Tests with two processes or simulated controllers competing for the lease.
- Controlled-clock tests for lease expiration and renewal.
- Orca adapter contract tests for provenance lookup and uncertain states.
- Test reconstructing a partially settled parallel state using only durable storage.

## Traceability

- PRODUCT.md: Invariants 5.5–5.7 and 5.12; Sections 6.2, 11, 15.4, 16.4, 19, 20, 21.3–21.4, 23.4–23.5, and 24.
- Normative scenario: 25.10; establishes the no-duplication guarantee required by 25.9.

## Definition of done

- Every identified crash window has a test proving at-most-once launch whenever an external execution may exist.
- A second controller cannot mutate a run with a valid lease.
- Complete execution state can be reconstructed without memory from the prior process.
- External uncertainty is never interpreted as permission to retry.
