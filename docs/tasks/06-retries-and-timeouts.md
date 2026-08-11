# Task 06: Retry failed attempts and enforce timeouts without duplicate execution

## Objective

Automatically recover from transient technical failures through bounded attempts while preserving the same visit context and guaranteeing that two external executions for the same task are never active at once.

## Functional value

A workflow can tolerate temporary agent failures or invalid results without losing traceability or repeating work that might still be running. When safe recovery is no longer possible or the budget is exhausted, the run ends with a verifiable cause.

## Dependencies

- Task 05.

## Scope

- Apply max_attempts as the total including the initial attempt; for example, 3 permits at most three attempts.
- Apply the effective attempt_timeout and retry_delay from already-validated defaults and overrides.
- Treat as retryable: failure reported by Orca, a process that ends without a valid result, missing or invalid result.json, an invalid outcome, and invalid documents.
- Treat a timeout as retryable only after confirming that the previous external execution is no longer active.
- Persist every failure, cause, retry decision, wait period, and attempt number.
- Reuse the same visit and immutable context.md, instructions, and prompt snapshot for every retry.
- Create a clean control workspace and new output paths for every attempt.
- Exclude all partial outputs from the failed attempt from both the retry and context.md.
- Preserve changes left by the failed attempt in the project workspace without promoting or reverting them.
- Wait the complete fixed retry_delay after confirming failure and before the next launch.
- Increment the attempt number without incrementing the visit or transition counters.
- When attempt_timeout expires, mark the attempt as timing out, request Orca cancellation, and reconcile until execution is confirmed stopped.
- Do not launch a retry while the prior attempt is active or its external state is uncertain.
- If uncertainty cannot be resolved safely, end the run as failed rather than duplicate work.
- When max_attempts is exhausted for a normal state, end the run as failed with the last error and complete attempt history.

## Out of scope

- Independent retries inside parallel states; Task 07 completes those using this same contract.
- workflow_timeout, max_state_visits, and max_transitions; those belong to Task 08.
- Reconciliation after the controller exits; that belongs to Tasks 09 and 10.
- Project-workspace rollback.
- Backoff strategies other than v1's fixed delay.

## Acceptance criteria

1. **Total budget:** Given max_attempts 3 and three consecutive failures, when the task executes, then exactly three attempts exist, not four, and the run ends as failed with the third error.
2. **Successful recovery:** Given that the first two attempts fail and the third produces a valid result, when execution completes, then only the third result is committed and the workflow continues exactly once.
3. **Fresh control context:** Given that the first attempt leaves partial outputs, when the second starts, then it uses a clean control workspace and cannot see those outputs through context.md.
4. **Stable visit context:** Given a retry, when the context.md, instructions, and prompt of both attempts are compared, then their content is identical and the retry remains in the same visit.
5. **Persistent source changes:** Given that the first attempt modifies the project workspace and then fails, when the retry begins, then the change remains in the workspace but is not indexed as a document.
6. **Fixed delay:** Given an effective retry_delay, when failure is confirmed, then the next launch does not occur before that delay elapses and the interval is observable in history.
7. **Reconciled timeout:** Given an attempt that exceeds attempt_timeout, when Orca confirms its cancellation, then only after that confirmation is the next attempt created.
8. **Uncertain timeout:** Given that Orca cannot confirm whether execution stopped, when safe reconciliation is exhausted, then no duplicate launches and the run ends as failed due to external uncertainty.
9. **Correct counters:** Given a state with two retries, when it eventually succeeds, then there is one visit and one transition; only the attempt count is 3.
10. **Typed failure:** For every normative retryable cause, when it occurs and max_attempts is exhausted, then the attempt and run retain a code and message that explain the final cause.

## Required tests

- Parameterized tests for every retryable cause in Section 16.1.
- Controlled-clock tests for retry_delay and attempt_timeout.
- Integration tests for confirmed cancellation, still-active execution, and uncertain external state.
- End-to-end test for the failure, failure, success scenario.
- Test contrasting control-workspace cleanup with project-workspace persistence.

## Traceability

- PRODUCT.md: Sections 4.4–4.5, 7.4, 11, 12.3, 13, 14, 16.1–16.4, 19.2, 20, and 23.2–23.4.
- Normative scenarios: 25.2, 25.4, 25.5, and 25.11.

## Definition of done

- Tests prove max_attempts is never exceeded and a retry never overlaps its predecessor.
- Every attempt has its own identity, workspace, logs, and reconciliation result.
- Retries do not alter visit or transition counters.
- External uncertainty always favors avoiding duplicate work.
