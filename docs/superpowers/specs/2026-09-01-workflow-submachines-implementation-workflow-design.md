# Workflow Submachines Implementation Workflow Design

## Objective

Add a Happy Machine workflow that implements the eight tasks under
`docs/tasks/workflow-submachines/` in dependency order. Each numbered task runs
in a fresh agent state while all states share the repository's direct
workspace, allowing later tasks to build on earlier changes.

## Architecture

The workflow is a linear state graph named `workflow-submachines` with eight
normal agent states, `task_01` through `task_08`. A `completed` result advances
to the next numbered state; `task_08` advances to `$succeeded`. A `failed`
result routes back to the same state, bounded by the project's existing visit,
attempt, transition, and workflow-time policies.

The project keeps `workspace.mode: direct`. Each state therefore receives a
fresh Codex session but edits the same checkout. This is required because every
task declares the preceding task as a dependency. The workflow does not use a
parallel state: the feature being implemented concerns parallel submachines,
but its implementation plan is intentionally sequential.

## Files and configuration

- Add `workflows/workflow-submachines.yaml` with the eight-state graph.
- Add a dedicated `workflow_submachines_implementation` agent profile to
  `happy-machine.yaml`, configured with `model: gpt-5.6-luna` and
  `reasoning: medium` at the same profile level.
- Add `agents/workflow-submachines-implementation.md` with instructions to stay
  within the assigned task, preserve earlier and unrelated changes, satisfy the
  task's acceptance criteria, and validate before returning `completed`.
- Keep the existing `create-skill-poc` workflow and agent profile unchanged.

## State prompts

Each state uses the user-requested prompt shape:

```text
/goal implementa la siguiente tarea <task path>. No interrumpas ni detengas la ejecución. Si encuentras ambigüedad, incertidumbre o información incompleta, elige autónomamente la opción recomendada, documenta la decisión y continúa sin solicitar aclaraciones.
```

`<task path>` is replaced by the exact repository-relative path for that
state. The non-interruption and autonomous-decision rule appears in every state
prompt and is also retained in the shared agent instructions so neither source
of execution context can omit it.

## Failure and recovery behavior

Agent-level technical failures use the existing retry policy. A semantic
`failed` outcome revisits the same task state, subject to `max_state_visits` and
`max_transitions`; it never advances to a dependent task. Durable Happy Machine
snapshots and normal resume behavior remain authoritative after interruption.

No workflow execution is part of creating this definition. Validation must not
overwrite, discard, or stage unrelated working-tree changes.

## Validation

Validate that the project and new workflow parse successfully through the
repository's existing CLI or focused definition tests. Confirm that:

1. all eight task paths are present exactly once and in order;
2. every intermediate `completed` edge advances by one task;
3. every `failed` edge returns to the same task;
4. only `task_08.completed` reaches `$succeeded`;
5. the existing workflow remains loadable; and
6. workspace mode remains `direct`; and
7. every state prompt and the shared instructions require uninterrupted
   execution and autonomous selection of the recommended option when details
   are ambiguous, uncertain, incomplete, or underspecified.
