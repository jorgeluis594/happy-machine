# Task 11: Inspect status, history, logs, questions, and escalations

## Objective

Allow a user to understand a run's current state and causally reconstruct every decision, retry, interruption, and Orca event without acquiring control of execution.

## Functional value

A durable workflow is operable only when it can be explained. This task makes visible which definition ran, what is active, why each transition occurred, and what external intervention may be pending.

## Dependencies

- Task 10.

## Scope

- Expose happy-machine status RUN_ID.
- Expose happy-machine history and happy-machine history RUN_ID.
- Discover the project for both commands and limit results to its local store.
- Keep status and history strictly read-only: they do not acquire the controller lease, reconcile work, or schedule work.
- Show in status: run ID, workflow ID, snapshot identity, status, terminal reason, and current state and visit.
- Show controller attachment and lease status without renewing or changing it.
- Show active, queued, succeeded, and failed tasks; attempts, effective deadlines, and retry timing.
- Show the last committed outcome and selected transition.
- Show worktree paths, HEADs, and dirty status when that metadata exists.
- Consume and persist structured Orca question and escalation events during attached execution or reconciliation.
- Show pending questions and escalations in status without interpreting them as outcomes or failures.
- Keep the attempt active and its ordinary timeout running while a question or escalation remains pending.
- Allow the event to be resolved externally through Orca; Happy Machine only observes and records the resolution.
- With history and no run ID, list project runs in reverse chronological order.
- With history RUN_ID, show an ordered sequence that explains the snapshot, visits, scheduling, launches, retries, outcomes, transitions, detach, resume, and termination.
- Persist events for run creation, leases, state entry, task scheduling, attempts, timeouts, technical cancellations, results, documents, joins, limits, and terminal status.
- Attribute each log stream to a run, state visit, task, and attempt even when logs are stored separately.
- Return exit code 0 when a read completes successfully and code 1 for an operational error or unknown run.

## Out of scope

- Answering or approving questions and escalations through Happy Machine.
- Acquiring the lease or repairing state from status or history.
- A graphical interface, webhooks, remote streaming, or an observability daemon.
- Inferring outcomes or decisions from free-form logs.
- Displaying environment secrets or content not declared in the snapshot.

## Acceptance criteria

1. **Active-run status:** Given a parallel state with active, queued, and succeeded tasks, when status runs, then it shows the correct categories, visit, attempts, deadlines, retry timing, lease, and last outcome without changing any of them.
2. **Terminal status:** Given a failed run, when status runs, then it shows the status, terminal reason, and final transition or global failure that caused it.
3. **Read without lease:** Given another controller with a valid lease, when status and history run, then both succeed without conflict, do not renew the lease, and do not change the run.
4. **Project listing:** Given several runs in the current project and runs in another project, when history runs without an ID, then only runs from the discovered project appear, newest first.
5. **Causal history:** Given a run containing a retry, transition, detach, and resume, when history RUN_ID is queried, then events appear in order and identify why every step occurred and which snapshot was used.
6. **Attributable logs:** Given a parallel state with several attempts, when logs are inspected, then each stream can be attributed unambiguously to a run, visit, task, and attempt.
7. **Pending question:** Given that Orca emits a structured question while the attempt remains active, then the event is persisted and appears in status; it does not change state, create an outcome, or pause the timeout.
8. **Pending escalation:** Given that Orca emits an escalation, when observed, then it is recorded like a question and Happy Machine does not attempt to answer it.
9. **External resolution:** Given that a question is resolved through Orca and the task finishes, when Happy Machine consumes the events, then history retains the question and resolution and processes the task's ordinary result.
10. **Unanswered question:** Given that the event remains pending until attempt_timeout expires, when timeout handling runs, then failure is recorded as timeout rather than question_failed.
11. **Document and join events:** Given a partially failed parallel state, when history is queried, then it shows successful document commits, the per-task summary, and aggregate calculation.
12. **No secret leakage:** Given an environment secret, when status, history, and Happy Machine-managed logs are queried, then the product does not add the secret from hidden configuration; any appearance must come from content explicitly written by an external tool.

## Required tests

- Golden tests for status output across every run status and task combination.
- Tests for history with and without a run ID, including ordering and project scope.
- Concurrency test proving read operations neither acquire nor renew leases.
- Contract tests for ingesting questions, escalations, and external resolutions.
- Timeout test with a pending question.
- Log-attribution test for normal, retry, and parallel-task execution.

## Traceability

- PRODUCT.md: Sections 6.2, 16.5, 20, 21.4, 22.1, 22.3–22.5, and 24.
- Normative scenario: 25.12; also provides evidence for 25.6–25.11.

## Definition of done

- Status and history are demonstrably read-only under an active controller.
- Every required event in PRODUCT.md Section 24 has a durable representation, stable ordering, and provenance.
- Questions and escalations are visible without becoming workflow control.
- An operator can explain every transition and retry using only status, history, and log references.
