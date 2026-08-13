# Warehouse Recount Sequential Workflow Design

## Purpose

Define a Happy Machine workflow that implements the eight warehouse-recount tasks sequentially. Every state starts a new Codex execution through Orca, while all states reuse one Happy Machine agent configuration. A failed task concludes the complete run, while a completed task advances to the next state.

Happy Machine owns the agent registry, workflow graph, prompts, policies, routing, retries, durable state, and terminal result. Orca is only the external executor used by Happy Machine to run the current state's agent through its CLI.

## Inputs

The workflow implements these task documents in order:

1. `docs/superpowers/tasks/warehouse-recount/01-operational-warehouse-isolation.md`
2. `docs/superpowers/tasks/warehouse-recount/02-start-continue-and-discard-recount.md`
3. `docs/superpowers/tasks/warehouse-recount/03-prepare-recount-batches.md`
4. `docs/superpowers/tasks/warehouse-recount/04-accept-edit-and-consolidate-batches.md`
5. `docs/superpowers/tasks/warehouse-recount/05-print-and-reprint-barcode-labels.md`
6. `docs/superpowers/tasks/warehouse-recount/06-review-confirm-and-execute-successful-merge.md`
7. `docs/superpowers/tasks/warehouse-recount/07-interrupt-and-resume-merge.md`
8. `docs/superpowers/tasks/warehouse-recount/08-handle-partial-failures-recovery-and-history.md`

The executing agent may also consult the two source specifications referenced by every task. The individual task document remains the authoritative scope for its state.

## Ownership Boundary

The declarative files are Happy Machine project configuration. Their presence in a target source repository does not make them Orca configuration.

At execution time:

1. Happy Machine loads and validates the complete project and workflow definition.
2. Happy Machine snapshots the agent instructions, prompts, policies, graph, and inputs.
3. Happy Machine selects the current state and prepares its attempt workspace.
4. The Orca adapter sends the current task specification using `run-create`, `task-create`, `worker-start`, and `check`.
5. Orca executes the agent and returns lifecycle information.
6. The agent writes the required `result.json`.
7. Happy Machine validates the result and selects the declared transition.

Only a validated `result.json` outcome controls routing. Orca stdout and stderr are retained as logs and never choose the next state.

## Definition Layout

The Happy Machine project uses this logical layout:

```text
happy-machine.yaml
.agents/
└── skills/
    └── telegram-jorge/
        └── SKILL.md
agents/
└── implementation.md
workflows/
└── warehouse-recount.yaml
```

The prompts remain inline in the workflow because each is short and used by exactly one state. The single instruction file exists because the current Happy Machine schema requires every registered agent to reference Markdown instructions. It contains reusable execution rules only; task scope remains entirely in each state prompt.

## Agent Registry

The registry contains one reusable agent:

| Agent ID | Instruction file | Default model | Assigned states |
| --- | --- | --- | --- |
| `implementation` | `agents/implementation.md` | `gpt-5.6-sol` | `task_01` through `task_08` |

The shared instruction file requires the executing agent to:

- Implement only its assigned task and treat earlier tasks as already completed.
- Treat every design, specification, and implementation plan produced through
  `brainstorming` for its assigned task as approved in advance by the user.
- Read the target repository instructions and the assigned task before editing.
- Preserve existing and earlier-state changes in the shared sequential workspace.
- Follow the repository's implementation and specialized-skill requirements.
- Run the focused automated tests and required type and quality checks.
- Perform the browser validation required by the state prompt through `qa-manual-web`.
- Send one screenshot already captured during successful `qa-manual-web`
  validation through `telegram-jorge` before returning `completed`.
- Return `completed` only when implementation and required validation succeed.
- Return `failed` when the implementation or required validation cannot be completed successfully.
- Never begin work belonging exclusively to a later task.

This registry entry is a Happy Machine configuration preset, not a persistent Orca agent. Each state still launches a fresh supervised Codex worker through Orca.

## Task Specification Injection

Happy Machine keeps reusable instructions and state-specific work separate in its effective definition. For each attempt, it sends Orca one JSON task specification containing both fields:

```json
{
  "instructions": "<contents of agents/implementation.md>",
  "prompt": "<state prompt plus the Happy Machine result contract>",
  "model": "gpt-5.6-sol"
}
```

Orca injects the complete task specification into the fresh Codex worker. It does not read `agents/implementation.md` itself. Happy Machine reads and snapshots that file before launch. Keeping the fields separate preserves the current product contract without duplicating task-specific instructions.

## Workflow Graph

Every state is a normal `agent` state referencing the shared `implementation` registry entry. The graph contains no parallel states and no cycles.

```text
task_01 ─completed→ task_02 ─completed→ task_03 ─completed→ task_04
   │                  │                  │                  │
 failed             failed             failed             failed
   │                  │                  │                  │
   └──────────────→ $failed ←────────────┴──────────────────┘

task_04 ─completed→ task_05 ─completed→ task_06 ─completed→ task_07
                                                             │
                                                          completed
                                                             │
                                                             ▼
                                                          task_08
                                                             │
                                              completed ──────┼────── failed
                                                  │          │          │
                                                  ▼          │          ▼
                                             $succeeded      └──────→ $failed
```

The normative transitions are:

| State | `completed` target | `failed` target |
| --- | --- | --- |
| `task_01` | `task_02` | `$failed` |
| `task_02` | `task_03` | `$failed` |
| `task_03` | `task_04` | `$failed` |
| `task_04` | `task_05` | `$failed` |
| `task_05` | `task_06` | `$failed` |
| `task_06` | `task_07` | `$failed` |
| `task_07` | `task_08` | `$failed` |
| `task_08` | `$succeeded` | `$failed` |

## Execution Policies

The project runs in `worktree` mode. Happy Machine creates one managed main worktree and reuses it for every sequential state, so each fresh execution receives the code produced by the preceding states.

The effective project defaults are:

```yaml
attempt_timeout: 60m
max_attempts: 1
retry_delay: 5s
workflow_timeout: 12h
max_state_visits: 1
max_transitions: 8
max_concurrency: 1
controller_lease: 30s
```

`max_attempts: 1` is essential: a technical attempt failure must conclude the machine rather than rerun the same implementation agent. `max_state_visits: 1` and `max_transitions: 8` express the intentionally acyclic eight-state graph. `max_concurrency: 1` documents sequential intent even though normal states already execute one task at a time.

## Prompts and QA Scope

Every task has browser-observable behavior and therefore invokes `qa-manual-web` after implementation. The first task also contains migration and persistence behavior that browser QA cannot prove, so its prompt explicitly requires both automated database validation and manual browser validation.

### Task 01

```text
/goal implement this task docs/superpowers/tasks/warehouse-recount/01-operational-warehouse-isolation.md. After implementing the code, validate the migration, backfill, database constraints, repository behavior, and affected inventory regressions with focused automated tests. Then use the qa-manual-web skill to validate that only OPERATIONAL/ACTIVE warehouses appear in browser lists and selectors, and that browser-submitted operations cannot use RECOUNT or ARCHIVED warehouses. When implementation and every required validation are successful, send any screenshot captured during qa-manual-web validation to Jorge using the telegram-jorge skill with a concise caption identifying this task. Return completed only after Telegram confirms the delivery; otherwise return failed.
```

The browser campaign prepares or discovers an `OPERATIONAL/ACTIVE`, an `OPERATIONAL/ARCHIVED`, and a `RECOUNT/ACTIVE` warehouse. It verifies that only the operational active warehouse is visible or selectable and that a crafted invalid submission cannot change inventory. Migration backfill and database constraints are validated in an isolated automated-test database, not inferred from the UI.

### Tasks 02 through 08

Each remaining prompt uses the same instruction with one of these exact task paths:

| State | Task path |
| --- | --- |
| `task_02` | `docs/superpowers/tasks/warehouse-recount/02-start-continue-and-discard-recount.md` |
| `task_03` | `docs/superpowers/tasks/warehouse-recount/03-prepare-recount-batches.md` |
| `task_04` | `docs/superpowers/tasks/warehouse-recount/04-accept-edit-and-consolidate-batches.md` |
| `task_05` | `docs/superpowers/tasks/warehouse-recount/05-print-and-reprint-barcode-labels.md` |
| `task_06` | `docs/superpowers/tasks/warehouse-recount/06-review-confirm-and-execute-successful-merge.md` |
| `task_07` | `docs/superpowers/tasks/warehouse-recount/07-interrupt-and-resume-merge.md` |
| `task_08` | `docs/superpowers/tasks/warehouse-recount/08-handle-partial-failures-recovery-and-history.md` |

For each row, the state prompt is the literal concatenation of `/goal implement this task `, the row's task path, and this suffix:

```text
. After implementing the code, validate the browser-observable functionality using the qa-manual-web skill. When implementation and every required validation are successful, send any screenshot captured during qa-manual-web validation to Jorge using the telegram-jorge skill with a concise caption identifying this task. Return completed only after Telegram confirms the delivery; otherwise return failed.
```

Task 05 browser QA validates the detectable Chrome handoff and application states, not physical printer output. Hardware, drivers, paper, and undetectable printer failures remain outside the automated workflow.

## Advance Brainstorming Approval

The user grants advance blanket approval to every design, specification, and
implementation plan produced through `brainstorming` for an assigned task. Each
worker must still complete the brainstorming process, present its design, write
and self-review its spec, and produce its implementation plan. It applies the
advance approval at review gates and continues without requesting duplicate
approval. A later user objection, change request, or revocation overrides the
advance approval.

## Telegram Evidence Delivery

Every state prompt explicitly requires Telegram evidence. After implementation,
automated checks, and browser validation are all successful, the worker selects
any screenshot already captured during `qa-manual-web` and invokes
`telegram-jorge` to send it with a concise caption identifying the current task.
No additional Telegram-specific screenshot is required. The skill owns its
delivery procedure and configuration. The worker must verify that delivery
succeeded before returning `completed`.

The `telegram-jorge` skill must be tracked by Git so it is present in the managed
worktree created from committed repository content. If the screenshot cannot be
captured, the skill cannot run, or delivery is not confirmed, the state returns
`failed` and the workflow terminates.

## Failure Semantics

The run terminates as failed under any of these conditions:

- The agent returns the semantic outcome `failed`.
- The attempt times out.
- Orca launch, execution, cancellation, or reconciliation fails or becomes unsafe.
- `result.json` is missing, malformed, or contains an undeclared outcome.
- A declared output document is invalid.
- The required validation screenshot cannot be captured or its Telegram
  delivery is not confirmed.
- A global workflow limit is exceeded.

Because every `failed` outcome targets `$failed` and `max_attempts` is one, no later state starts after a failed implementation or validation.

Questions and escalations emitted by Orca remain durable intervention evidence. They do not create a workflow outcome, pause deadlines, or authorize Happy Machine to answer on the agent's behalf.

## Validation of the Configuration

Before the workflow is considered runnable:

1. Load the complete definition through the Happy Machine definition loader.
2. Verify the closed YAML schema, agent references, instruction paths, model values, policies, state reachability, and terminal paths.
3. Verify that every task document resolves canonically inside the Happy Machine project root.
4. Verify that the target repository supports Git worktrees.
5. Confirm that validation produces no run, workspace, or Orca side effect.
6. Exercise a controlled executor fixture that returns `completed` for all states and assert the ordered eight-state successful path.
7. Exercise a controlled `failed` outcome at each state and assert immediate `$failed` termination with no later task launch.
8. Verify that every state prompt requires a validation screenshot,
   `telegram-jorge`, and confirmed delivery before `completed`.

Actual execution of the eight implementation states is separate from definition validation because it mutates the target codebase and performs the feature work described by the tasks.

## Completion Criteria

The configuration is complete when:

- The shared `implementation` agent resolves to `agents/implementation.md` and uses `gpt-5.6-sol`.
- All eight states reference the shared `implementation` agent.
- The workflow validates before allocating a run.
- The successful controlled path visits all eight states exactly once and terminates at `$succeeded`.
- A controlled failure at any state terminates at `$failed` and launches no later state.
- The effective policies match this design.
- All prompts reference the intended task and require the approved validation scope.
- Shared instructions apply the user's advance approval to brainstorming
  designs, specifications, and implementation plans.
- `telegram-jorge` is available in committed worktree content and every state
  requires confirmed screenshot delivery before `completed`.
- No workflow or routing responsibility is delegated to Orca.
