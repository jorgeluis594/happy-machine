# Task 02: Reject invalid definitions before creating a run

## Objective

Validate the complete effective project and workflow definition before allocating a run ID or producing any durable or external side effect.

## Functional value

Users can trust that execute will not start work with ambiguous, unsafe, or nonterminating configurations. Errors are detected early and leave no ghost runs, workspaces, or Orca tasks.

## Dependencies

- Task 01.

## Scope

- Parse YAML while rejecting duplicate keys at every relevant level.
- Reject schema versions other than 1 and unknown fields.
- Validate required fields in happy-machine.yaml, agents, models, instructions, executor configuration, and workspace configuration.
- Validate policy defaults and overrides, their types, positive values, permitted scopes, and effective precedence.
- Apply normative defaults when a policy is omitted.
- Validate workflow ID, initial_state, normal states, parallel states, tasks, agents, prompts, outcomes, and terminal targets.
- Require exactly one of prompt or prompt_file where applicable.
- Require a parallel state to have at least one task and exactly the outcomes succeeded and failed.
- Reject duplicate IDs or outcomes, references to unknown agents or states, and outcomes without exactly one target.
- Permit cycles, including a self-loop, provided the graph satisfies all other invariants.
- Reject states unreachable from initial_state and reachable states that cannot reach $succeeded or $failed.
- Reject on_failure and every form of arbitrary executable configuration.
- Verify that instruction and prompt files exist, have the expected form, and remain inside the project root.
- Reject any configuration, workflow, instruction, or prompt path that escapes the project root.
- Reject workspace.mode worktree when the project cannot support Git worktrees.
- Guarantee that a definition error exits with code 1 without allocating a run ID, creating durable state, preparing workspaces, or invoking Orca.

## Out of scope

- Validating the semantic content of Markdown written by agents.
- Executing a valid workflow beyond the behavior delivered by Task 01.
- Validating result.json; that belongs to Task 05.
- Adding a validate command, which is not part of the v1 contract.

## Acceptance criteria

1. **No side effects:** For every definition error covered by PRODUCT.md Section 9, when execute is invoked, then it returns exit code 1 and creates no run ID, durable record, managed workspace, or Orca call.
2. **Closed schema:** Given an unknown field or a version other than 1 in the project or workflow definition, when validation runs, then it reports the error location and rejects execution.
3. **Unambiguous YAML:** Given a duplicate configuration, state, task, or outcome key, when the document is parsed, then it is rejected even if the YAML parser would otherwise retain only one value.
4. **Valid local registry:** Given a workflow that references an unknown agent, declares an invalid runtime or legacy model field, or uses a missing instruction file, when validation runs, then it is rejected before run creation.
5. **Mutually exclusive prompts:** Given a state or task with both prompt and prompt_file, or neither, when validation runs, then it is rejected with an error attributable to that state or task.
6. **Valid graph:** Given an unknown initial_state, unknown target, unreachable state, or reachable state without a path to a terminal, when validation runs, then the definition is rejected.
7. **Cycles allowed:** Given a cyclic graph where every state is reachable and can reach a terminal, when validation runs, then the cycle alone does not cause rejection.
8. **Closed parallel state:** Given a parallel state with no tasks or with outcomes missing, additional to, or different from succeeded and failed, when validation runs, then it is rejected.
9. **Effective policies:** Given values at project, workflow, state, and parallel-task scope, when a policy is computed, then the most specific permitted scope wins; an override at a forbidden scope or a nonpositive value is rejected.
10. **Normative defaults:** Given a configuration without defaults, when validation runs, then the effective values are attempt_timeout 30m, max_attempts 3, retry_delay 5s, workflow_timeout 24h, max_state_visits 10, max_transitions 100, max_concurrency 4, and controller_lease 30s.
11. **Path safety:** Given a relative path or symbolic link that resolves outside the project root after canonicalization, when validation runs, then it is rejected. This rule does not yet apply to explicit CLI inputs.
12. **No arbitrary code:** Given a definition that attempts to include a command or executable code outside the schema, when validation runs, then it is rejected as an unknown field or invalid form.

## Required tests

- Parameterized tests for every rejection cause listed in PRODUCT.md Section 9.
- Graph tests for forward edges, cycles, self-loops, unreachable states, and lack of a terminal path.
- Table tests for defaults, precedence, and scopes of every policy.
- Path tests covering traversal, symbolic links, and missing files.
- Integration test that spies on storage, filesystem operations, and Orca to prove that an error produces no effects.

## Traceability

- PRODUCT.md: Sections 6.1, 7, 8, 9, 22.2, 22.5, and 23.1.

## Definition of done

- An explicit negative automated test exists for every normative rejection rule.
- At least one positive test exists for every valid form that could be mistaken for an error, especially cycles and normal outcomes named succeeded or failed.
- All validation occurs before the first run-creation side effect.
- Errors provide enough context to fix the file without consulting internal logs.
