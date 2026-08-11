# Bounded Cycles and Global Workflow Limits

## Goal

Implement Task 08 so every transition may enter any declared state, including
the current state or a previously visited state, while durable visit,
transition, and wall-clock limits guarantee termination. Cycles use new visits
and fresh context snapshots; retries remain attempts inside one visit.

## Domain Model and Limit Evaluation

`RunRecord` stores the durable workflow deadline and the number of committed
transitions. The deadline is calculated once from the durable creation time and
the snapshotted effective `workflow_timeout`; it is not extended by controller
detach, retries, questions, escalations, or reconciliation.

The execution domain owns pure limit evaluations. Each evaluation returns an
allowed or exceeded decision plus the effective limit, observed value, and
stable terminal cause. The rules are inclusive:

- `max_state_visits: N` allows entries 1 through N for each state ID and rejects
  attempted entry N+1 with `max_state_visits_exceeded`.
- `max_transitions: N` allows edges 1 through N, including terminal edges, and
  rejects attempted edge N+1 with `max_transitions_exceeded`.
- `workflow_timeout` is exceeded when the current wall clock is at or beyond
  the durable deadline and terminates with `workflow_timeout`.

The application supplies the current time; domain code does no I/O and never
reads the clock directly.

## State Entry and Cycles

Every target state, whether forward, backward, or self-referential, passes
through the same state-entry algorithm. Before creating a visit, preparing
context, or launching a task, the controller evaluates the workflow deadline
and the proposed per-state visit count. A denied entry creates no visit and
launches no agent.

An allowed entry creates the next visit number for that state and writes a new
`context.md` from all documents committed at that point. Documents from earlier
visits to the same state and feedback from intervening states therefore appear
in the new snapshot. Retries do not use state entry: they reuse their visit,
visit number, and immutable context.

## Transition Boundary

After a normal result or parallel join has settled and its documents are ready,
but before committing its outcome or target, the controller evaluates the
workflow deadline and proposed transition count. If either limit is exceeded,
the result remains attempt or join evidence, but no state outcome, target,
transition, terminal target, or workflow documents are committed from that
unresolved edge. The run ends with the global failure.

If allowed, the controller atomically commits the validated result, documents,
outcome, target, incremented transition count, and transition event. Terminal
targets count exactly like state targets.

## Workflow Deadline During Work

Each attempt races external completion against two deadlines: its effective
attempt deadline and the run's fixed workflow deadline. The earlier deadline
controls. Attempt timeout retains the existing retry behavior. Workflow timeout
is nonrouteable and stops the entire run.

When workflow timeout wins with an active attempt, the controller marks the
attempt as timing out for the global cause, requests Orca cancellation, and
uses the existing bounded reconciliation process. It preserves executor IDs,
logs, cancellation requests, and reconciliation observations. The terminal
cause remains `workflow_timeout` even if Orca cannot confirm a stop within the
reconciliation window; unresolved external status is retained as evidence and
no new work is scheduled.

Parallel scheduling consults the shared run deadline before each queued task is
claimed. Once expiration is observed, workers stop claiming tasks. Every active
sibling is cancelled and reconciled independently, and the controller waits
for that handling to settle before recording the single run failure. Queued
tasks retain their queued records and are never launched.

## Deadline-Aware Waiting

Retry delay waits race their configured delay against the remaining workflow
time. The controller evaluates and records the deadline before the delay, when
the wait resolves, and before the next attempt. Expiration during the delay
ends the run without creating another attempt.

Orca questions and escalations already keep the executor promise active. The
same workflow-deadline race therefore includes time spent awaiting them and
cancels the active attempt when the deadline wins.

V1 has no deadline daemon. A detached controller performs no background action.
The pure deadline evaluator accepts any durable run and current controller time,
so Task 10 can invoke the same pre-scheduling check on resume. Task 08 tests
this contract by reconstructing a running record whose durable deadline passed
during a controller-free interval and proving evaluation denies new work before
launch; it does not add the resume command itself.

## Failure and Events

Global-limit failures are run failures, never workflow outcomes. A shared
termination path sets run status `failed`, records the stable cause, emits a
terminal event, persists the record, and returns it without following any state
transition.

Every evaluation is durable and includes:

- limit name and effective value or deadline;
- observed visit count, proposed transition count, or evaluation time;
- state ID and visit number when applicable;
- allowed or exceeded decision;
- stable terminal cause when exceeded.

Evaluation events occur before the work or edge they authorize, making the
causal history auditable even at exact N and N+1 boundaries.

## Architecture

Pure inclusive-boundary rules and stable failure causes belong in
`src/domain/execution/`. `ExecuteWorkflow` coordinates evaluations, clock and
wait races, cancellation, reconciliation, persistence order, and state entry.
The existing task-executor and run-repository ports remain sufficient; their
adapters continue to own Orca and filesystem details. No new architectural
layer or resume interface is introduced.

## Testing

Deterministic tests cover:

- a draft/review/backward cycle whose second draft context contains prior draft
  output and review feedback;
- a self-loop that creates distinct visits and finishes normally;
- forward transition coverage through the same entry algorithm;
- retries remaining in one visit while attempts increase;
- exact N and denied N+1 boundaries for visits and transitions, including a
  terminal transition at N;
- nonrouteable limit failures with no fabricated outcome or launch;
- controlled-clock expiration during an active attempt, retry delay, simulated
  pending question, and detached interval;
- cancellation and safe reconciliation evidence for active attempts;
- parallel expiration stopping queued scheduling and reconciling active tasks;
- causal events containing effective limits, observations, decisions, and
  stable terminal causes.

Final verification runs lint/format fixes, the complete test suite, TypeScript
checking, and an explicit audit against all ten acceptance criteria and every
required test in Task 08.
