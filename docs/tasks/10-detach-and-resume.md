# Task 10: Detach and resume runs without repeating Orca work

## Objective

Allow a user to leave the CLI process without canceling the run and resume it later, first reconciling any existing external work.

## Functional value

Long-running workflows survive terminal closure. A user can return hours later and continue from durable evidence without losing results, ignoring deadlines, or running an agent twice.

## Dependencies

- Task 09.

## Scope

- Expose happy-machine resume RUN_ID.
- Treat Ctrl+C, terminal closure, or controller loss as detach, not cancellation.
- Make Ctrl+C terminate the CLI with exit code 130 while preserving a nonterminal run.
- Explicitly release the lease when possible or allow it to expire after abrupt controller loss.
- Durably represent the run as detached when no controller is active.
- Allow an already-launched Orca task to continue while the run is detached.
- Schedule no new states, tasks, or retries while detached, and run no scheduling daemon.
- Keep workflow and attempt deadlines active during detach.
- On resume, load only the original snapshot and reject terminal runs.
- Acquire the controller lease before any mutation.
- Reconcile every nonterminal attempt using persisted IDs and provenance before scheduling work.
- Commit results found during reconciliation using the normal rules.
- Apply expired attempt timeouts and global limits before starting anything new.
- Observe an active external execution instead of launching it again.
- Continue the workflow from the pending transition or work only after all external state is reconciled.
- If workflow_timeout expired while detached, stop or reconcile active work safely and end as failed with workflow_timeout without scheduling new tasks.
- Keep resume attached until terminal completion or another detach.
- Return 0, 1, 2, or 130 according to the result ultimately observed by the attached command.

## Out of scope

- Canceling the run with Ctrl+C.
- Continuing complete workflow scheduling in the background without a CLI.
- Resuming a succeeded, failed, or canceled run.
- Changing a run snapshot after editing project files.
- Answering questions or escalations from Happy Machine.

## Acceptance criteria

1. **Ctrl+C detaches:** Given an active Orca attempt, when the user presses Ctrl+C, then the CLI exits 130, the run becomes detached, no cancellation is requested, and external execution may continue.
2. **No detached scheduling:** Given an attempt that finishes while detached and whose outcome leads to another state, when no controller exists, then the next state does not begin.
3. **Result discovered on return:** Given that the attempt finished during detach, when resume runs, then its result is committed and the next state continues without repeating the attempt.
4. **Work still active:** Given that Orca is still running the attempt, when resume runs, then the controller observes that attempt and does not create another.
5. **Original snapshot:** Given that the workflow, agents, prompts, or models changed during detach, when resume runs, then it uses the original snapshot content and values.
6. **Original input modified:** Given that an --input file was edited during detach, when the run resumes, then later agents receive the run's immutable copy.
7. **Deadline expired while detached:** Given that workflow_timeout expired without a controller, when resume runs, then active work is safely reconciled or canceled and the run ends as failed with workflow_timeout before scheduling work.
8. **Attempt timeout expired while detached:** Given an attempt whose deadline expired during detach, when the run resumes, then cancellation is requested and no retry launches until the prior attempt is confirmed stopped.
9. **Terminal run:** Given a succeeded, failed, or canceled run, when resume is invoked, then it is rejected without changing status or creating attempts.
10. **Lease conflict:** Given another controller with a valid lease, when resume is invoked, then run_already_controlled is returned and the run does not change.
11. **Attached exit:** Given a resume process that remains attached until terminal status, when the run reaches succeeded, failed, or canceled, then it returns 0, 1, or 2 respectively.

## Required tests

- End-to-end test that sends a real interrupt signal to the CLI process while a controlled Orca fixture is active.
- Resume tests with active, completed, failed, and uncertain external execution.
- Test that edits the definition and original input during detach.
- Controlled-clock tests for workflow_timeout and attempt_timeout expiring while detached.
- Test proving no new launch occurs between detach and resume.

## Traceability

- PRODUCT.md: Invariants 5.1, 5.6–5.8, and 5.12; Sections 10.2, 16.4–16.5, 17.4, 19.4, 20, 21.1–21.4, 22.1, 22.5, and 23.5.
- Normative scenarios: 25.9, 25.10, 25.13, 25.14, and 25.20.

## Definition of done

- A real-process test proves exit code 130 and absence of cancellation after Ctrl+C.
- Resume reconciles every external state before scheduling and never duplicates recoverable work.
- Deadlines elapsed during detach produce the same result as if a controller had remained attached.
- Terminal runs are immutable with respect to resume.
