# Task 08: Execute bounded cycles and enforce global workflow limits

## Objective

Permit transitions to previously visited states while preventing cycles, excessive transitions, or total elapsed time from consuming resources indefinitely.

## Functional value

Workflows can iterate through review and revision while always terminating within declared, auditable limits. A user can clearly distinguish a new iteration from a technical retry.

## Dependencies

- Task 07.

## Scope

- Permit forward, backward, and self-referential transitions using the same state-entry algorithm.
- Create a new visit whenever a transition enters a state, even when that state was visited before.
- Generate a fresh context.md for the new visit containing every document committed by that point, including documents from earlier visits to the same state and intermediate feedback.
- Preserve the distinction between a new visit caused by a cycle and a new attempt caused by a retry.
- Enforce max_state_visits per state ID and permit exactly N entries when the value is N.
- Enforce max_transitions across the run and include transitions to $succeeded and $failed.
- Enforce workflow_timeout as a wall-clock deadline measured from durable run creation.
- Count time spent in agents, retry delays, questions, escalations, and detached periods toward the deadline.
- Evaluate limits before starting new work or resolving an additional transition.
- End as failed with max_state_visits_exceeded when attempting visit N+1.
- End as failed with max_transitions_exceeded when attempting transition N+1.
- When workflow_timeout expires with an attached controller, stop scheduling, request cancellation of active work, preserve evidence, and end as failed after safe reconciliation.
- If the deadline expires while detached, defer detection and reconciliation to the next controller without running a daemon.
- Treat global-limit failures as nonrouteable failures that do not produce outcomes.
- Record every limit evaluation and its corresponding terminal cause.

## Out of scope

- An on_failure edge for global failures.
- Limits by outcome type or other counters not declared by v1.
- Pausing the clock while a run is detached or awaiting external intervention.
- A daemon that enforces deadlines in the background.
- The complete resume command experience; that belongs to Task 10.

## Acceptance criteria

1. **Cycle with new context:** Given review → needs_revision → draft, when execution returns to draft, then draft visit 2 is created and its context.md contains the prior draft and review feedback.
2. **Self-loop:** Given a state that targets itself and later reaches a terminal, when it executes, then every entry has a distinct visit and the run can finish normally within its limits.
3. **Retry is not a visit:** Given an attempt that retries twice within one visit, when it finally succeeds, then max_state_visits counts only one entry.
4. **Inclusive visit limit:** Given max_state_visits N, when a state completes N visits, then all are allowed; attempting N+1 ends the run as failed with max_state_visits_exceeded without launching the agent.
5. **Terminal counts as a transition:** Given max_transitions N, when edge N leads to a terminal, then it is allowed; any N+1 edge ends as failed with max_transitions_exceeded.
6. **Global failure is not routeable:** Given a state with valid outcomes and an exceeded limit, when the limit is detected, then no outcome is fabricated and none of the state's transitions are followed.
7. **Attached deadline:** Given an active attempt when workflow_timeout expires and a controller is present, then no more work is scheduled, cancellation is requested, evidence is preserved, and the run ends as failed with workflow_timeout after safe reconciliation.
8. **Accumulated time:** Given that a run spends time in retry_delay or waiting for a question, when the deadline expires, then that time counts and workflow_timeout applies.
9. **Detached deadline:** Given a detached run whose deadline expires, when no controller exists, then no background action starts; the next controller detects expiration before scheduling work.
10. **Causal events:** Given any exceeded limit, when durable state is inspected, then a limit-evaluation event records the effective value, observed counter or deadline, and terminal cause.

## Required tests

- End-to-end test for a draft/review cycle that eventually succeeds.
- Boundary tests at N and N+1 for visits and transitions.
- Test comparing cycle and retry counters.
- Controlled-clock tests for an attached deadline, retry delay, pending question, and detached period.
- Test of active-attempt cancellation and reconciliation when the workflow deadline expires.

## Traceability

- PRODUCT.md: Sections 4.4, 5, 7.4, 8.5, 10.3, 14, 17, 21.2–21.3, and 23.4.
- Normative scenarios: 25.3 and 25.20.

## Definition of done

- Forward cycles, backward cycles, and self-loops have automated coverage.
- All three global limits have boundary tests and stable terminal causes.
- No global limit can become a workflow outcome.
- Clock semantics are identical during execution, waiting, and detach.
