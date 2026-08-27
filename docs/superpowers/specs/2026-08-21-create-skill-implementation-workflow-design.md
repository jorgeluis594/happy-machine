# Create-Skill Implementation Workflow Design

**Status:** Approved

**Date:** 2026-08-21

## Purpose

Define a Happy Machine workflow that implements the 18 tasks in
`docs/superpowers/plans/2026-08-21-create-skill-poc.md` sequentially. Every
state starts a fresh Codex execution whose prompt begins with `/goal` and
assigns exactly one task from the plan.

The workflow optimizes for a fast first delivery without relying on Happy
Machine worktree behavior that has not yet been exercised in this repository.

## Sources of Truth

The executing agent must consult these documents:

1. `docs/superpowers/plans/2026-08-21-create-skill-poc.md`
2. `docs/superpowers/specs/2026-08-20-create-skill-poc-product-design.md`
3. `docs/superpowers/specs/2026-08-21-create-skill-poc-technical-design.md`
4. `docs/ARCHITECTURE.md`

The implementation plan assigns task scope and validation. The product design
owns functional behavior. The technical design owns implementation boundaries
and its explicit clarifications override less-specific product wording.

## Project Layout

The workflow adds this Happy Machine project configuration:

```text
happy-machine.yaml
agents/
└── create-skill-implementation.md
workflows/
└── create-skill-poc.yaml
```

`happy-machine.yaml` uses the Orca executor and `workspace.mode: direct`. The
single registered agent uses `gpt-5.6-sol`, the implementation model already
selected by this repository's approved implementation-workflow design. All 18
states reference that agent. The current Orca adapter does not forward this
model value to Codex, so the local Codex configuration remains authoritative at
runtime; the model value is still snapshotted as part of the workflow contract.

The direct workspace is intentional. Each sequential agent sees the source
changes and commits produced by earlier states. The workflow creates no child
worktrees and requires no merge or integration states.

## Workflow Graph

The graph contains 18 normal agent states:

```text
task_01 -> task_02 -> task_03 -> ... -> task_18 -> $succeeded
   ^          ^          ^                 ^
   | failed   | failed   | failed          | failed
   +----------+----------+-----------------+
       each failed outcome returns to its own state
```

For every state:

- `completed` advances to the next numbered task.
- `failed` returns to the same state.
- Task 18 sends `completed` to `$succeeded`.
- A technical execution failure uses the attempt retry policy rather than a
  semantic transition.

The workflow is entirely sequential. `max_concurrency` is one, and no state has
`type: parallel`.

## Retry and Limit Semantics

The effective policies are:

```yaml
attempt_timeout: 60m
max_attempts: 3
retry_delay: 5s
workflow_timeout: 24h
max_state_visits: 3
max_transitions: 54
max_concurrency: 1
controller_lease: 30s
```

`max_attempts: 3` allows up to three executions within one state visit when an
attempt fails technically, including timeouts, interrupted execution, or an
invalid result contract.

An agent-declared `failed` outcome creates another visit to the same state.
`max_state_visits: 3` permits no more than three semantic visits to one task.
The combined worst case is nine executions of one task: three visits, each
with three technical attempts. Exhausting a global limit terminates the run as
an engine failure.

`max_transitions: 54` allows the successful 18-state path plus two semantic
retries for every task while remaining bounded. The 24-hour workflow deadline
is the final wall-clock limit.

## Agent Contract

`agents/create-skill-implementation.md` is written in English and instructs
the agent to:

- Work only on the task assigned by the current prompt.
- Treat earlier numbered tasks as completed and preserve their changes.
- Preserve unrelated user changes in the direct workspace.
- Read the repository instructions, assigned task, source designs, and
  architecture before editing.
- Follow repository skills and implementation requirements.
- Resolve underspecified requirements autonomously by analyzing alternatives,
  selecting the recommended option, documenting the decision, and continuing.
- Never ask the user or another party to define requirements, design, or
  implementation details.
- Avoid expanding authorization to destructive, external, or out-of-scope
  actions merely to resolve ambiguity.
- Run the focused validation required by the task and the plan.
- Create a coherent commit only after the task and required validation are
  complete.
- Return `completed` only after the assigned implementation and validation
  succeed.
- Return `failed` when the assigned outcome cannot be completed.
- Never begin work that belongs exclusively to a later task.

## Prompt Contract

Every workflow prompt is written in English and starts with `/goal` as its
literal first token. Happy Machine preserves the configured prompt as the
prefix sent to Codex before appending agent instructions, execution context,
and the `result.json` contract.

Each prompt follows this structure:

```text
/goal Implement Task NN, "<task title>", from docs/superpowers/plans/2026-08-21-create-skill-poc.md. Work only on that task and satisfy all of its scope, acceptance criteria, and validation requirements. Read the referenced product design, technical design, and docs/ARCHITECTURE.md before editing. Treat earlier tasks as completed and preserve their changes. If any part of this task is underspecified, analyze the viable alternatives and autonomously choose the recommended option. Do not ask for assistance defining requirements, design, or implementation. Document the decision and continue. Return completed only after the implementation and required validation succeed; otherwise return failed. Do not start work that belongs exclusively to a later task.
```

The task number and exact heading distinguish the assigned work. A prompt does
not assign multiple tasks, even when the implementation plan says that work
could have run in parallel.

Task 18 retains the plan's full-validation and real-Codex smoke-test
requirements. The agent must not report `completed` if a required validation
has not succeeded.

## Error Handling

Happy Machine remains the routing authority:

- Agent prose, logs, and terminal state never select the next state.
- Only a valid `result.json` outcome controls semantic routing.
- A `failed` outcome retries the same numbered state within the visit limit.
- Technical failures retry within `max_attempts`.
- No later task starts until the current task returns `completed`.
- Exhausted retries, unsafe executor state, invalid workflow results after the
  retry budget, or global-limit violations fail the run.

Questions emitted by an execution do not pause limits and do not authorize
Happy Machine to answer. The agent contract therefore requires autonomous
resolution of missing definitions inside the assigned scope.

## Validation

The configuration is complete only when an automated test loads it through the
real `FilesystemProjectDefinitions` parser and verifies:

1. The project selects `workspace.mode: direct` and one registered agent.
2. The workflow contains exactly 18 reachable normal states.
3. The initial state is `task_01` and the successful path is ordered through
   `task_18` to `$succeeded`.
4. Every `failed` outcome targets its own state.
5. Every prompt begins with `/goal` and assigns exactly one numbered task.
6. Every prompt includes the autonomous recommended-option instruction.
7. Every state uses three technical attempts, and project limits permit three
   semantic visits with concurrency one.
8. The shared instructions require focused validation, preservation of prior
   changes, commit readiness, autonomous definition decisions, and strict task
   scope.
9. The Task 18 prompt retains full validation and the real Codex smoke test.

Focused validation for the workflow files runs the new configuration test plus
`npm run typecheck`. Full repository validation runs `npm test` and
`npm run typecheck` before handoff.

## Completion Criteria

The workflow design is implemented when:

- The three configuration files exist at the approved paths.
- All configuration and agent text is valid and all prompts are in English.
- The parser accepts the complete definition without creating a run.
- Automated tests prove task ordering, retry loops, policies, prompt clauses,
  and final termination.
- Existing unrelated working-tree changes remain untouched.
