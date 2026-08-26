# Task 07: Execute parallel states with bounded concurrency and an all-settled join

## Objective

Execute every task declared by a parallel state, enforce its concurrency limit, and produce one deterministic aggregate outcome after all tasks have settled.

## Functional value

A workflow can run independent reviews, tests, or analyses concurrently without losing useful partial results or hiding failures. The following transition receives a complete account of what happened.

## Dependencies

- Task 06.

## Scope

- Create one durable task for every task ID declared in a parallel state.
- Resolve each task's agent, instructions, prompt or prompt_file, runtime, and effective policies, including mixed Codex/OpenCode profiles and valid policy overrides.
- Fix one context snapshot before fan-out.
- Give every task in the visit the same committed context, even when concurrency limits delay some starts.
- Prevent a task from seeing sibling documents while the join remains open.
- Give each task its own control workspace, attempts, outputs, logs, and Orca identifiers.
- Run at most min(effective max_concurrency, task count) tasks simultaneously.
- Start queued tasks as capacity becomes available without stopping scheduling because another task failed.
- Permit only succeeded or failed in a parallel task's result.json.
- Treat a task-declared failed result as a retryable attempt failure.
- Apply timeout, retries, and delay independently to each task.
- Wait until every task has succeeded or exhausted its attempts.
- Calculate succeeded only when every task succeeded, and failed when at least one exhausted its attempts.
- Commit and preserve every successful task document and every failed task record.
- Resolve exactly the succeeded or failed transition declared by the state; no agent selects the aggregate outcome.
- Give the next state successful documents, every task's final status, attempts and final error summary, audit references, and available workspace metadata.
- Treat an engine inability to calculate or persist the join as run failure, not aggregate failed.
- Do not synthesize documents, cancel siblings after one failure, or merge source changes.

## Out of scope

- Multi-state subflows running in parallel.
- Reusable subflow definitions.
- Fail-fast behavior, automatic sibling cancellation, or thresholds other than all-successful.
- Automatic merging of documents or Git changes.
- Project-workspace isolation through worktrees; that belongs to Task 13. In direct mode, tasks share the workspace under the workflow author's accepted risk.

## Acceptance criteria

1. **Successful join:** Given three tasks that eventually return succeeded, when all settle, then the state emits exactly one succeeded and follows its transition only after the final task completes.
2. **Failed all-settled join:** Given one task that exhausts its attempts while others are running or queued, when failure occurs, then the remaining tasks continue and the state emits failed only after all have settled.
3. **Bounded concurrency:** Given five tasks and max_concurrency 2, when the state executes, then no more than two are active at once and every task reaches a final status.
4. **Effective limit:** Given max_concurrency greater than the task count, when execution begins, then effective concurrency equals the task count and no fictitious slots are created.
5. **Context frozen before fan-out:** Given a fast task that produces a document and a queued task that starts later, when the second starts, then its context.md does not contain the sibling document.
6. **Independent retries:** Given that one task fails once and another succeeds, when the first retries, then the second is not repeated and each attempt count is independent.
7. **Declared failed is retryable:** Given that a task returns failed and then succeeded within its budget, when the join completes, then its final status is succeeded and it can contribute to aggregate succeeded.
8. **Complete downstream context:** Given aggregate failed with two successful tasks and one failed task, when inspect_failures starts, then it receives both successful documents and the status, attempt count, and final error of all three tasks.
9. **Calculated outcome:** Given logs or documents that say failed while every task validly returns succeeded, when the join is calculated, then the aggregate is succeeded.
10. **Engine failure:** Given that the aggregate cannot be persisted safely, when the external join finishes, then the run ends as failed due to an engine error and does not follow the workflow's failed transition.
11. **Control isolation:** Given two simultaneous tasks with the same output basename, when they finish, then their result.json files, logs, and documents do not collide and retain separate provenance.

## Required tests

- End-to-end tests for succeeded and failed joins.
- Instrumented-scheduler test proving the concurrency maximum and absence of fail-fast behavior.
- Sibling-visibility test with a fast task and a queued task.
- Test of independent retries and timeouts per task.
- Fault-injection test while persisting the aggregate.
- Direct-mode test documenting shared project workspace and isolated control workspaces.

## Traceability

- PRODUCT.md: Sections 3.1–3.2, 4.4–4.6, 7.4, 8.3, 10.3, 12.2–12.3, 13, 15, 16.1–16.3, 18.1, 19.3, and 23.3–23.4.
- Normative scenarios: 25.6, 25.7, and 25.8.

## Definition of done

- Deterministic tests prove the concurrency maximum, all-settled join, and aggregate calculation.
- Every task retains independent identity, retries, outputs, and errors.
- A later state can explain the complete fan-out result without reading free-form logs.
- No sibling receives documents produced during the same join.
