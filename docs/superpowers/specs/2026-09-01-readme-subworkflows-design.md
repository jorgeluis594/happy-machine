# README sub-workflows documentation design

## Objective

Document reusable child workflows in the README as a natural extension of the existing workflow walkthrough, without giving the feature disproportionate prominence.

## Placement and scope

- Extend the project tree and core-capabilities list with concise references to reusable workflows.
- Add a compact subsection inside **Create a minimal project**, after the existing `delivery.yaml` example and before execution instructions.
- Do not add a new top-level section, architecture discussion, controller details, or evaluator policy details.

## Examples

The subsection will explain that workflow-backed work is available inside parallel states and show two small YAML fragments:

1. A static parallel map whose selected entry declares `type: workflow`, references a registered workflow ID through `workflow`, and supplies an immutable nonempty `with` map.
2. A dynamic parallel state using `for_each`; its required `task` template also declares `type: workflow` and binds the complete `$item` through `with`.

Both examples execute child workflows rather than agent tasks. In the dynamic form, `task` is the schema key for the repeated template, not an agent-task selection.

## User-facing semantics

The accompanying text will state only the behavior needed to use the feature correctly:

- Referenced workflows must be registered in `happy-machine.yaml`.
- Each wrapper creates one durable child run with normal workflow behavior and recovery.
- The parent evaluates the child into `succeeded | failed` for its existing all-settled parallel join.
- Dynamic cardinality and `max_concurrency` remain controlled by the parent parallel state.

## Validation

- Run README example tests so every marked or parsed example remains valid.
- Run formatting/lint, the full test suite, and type checking according to repository policy.
- Keep unrelated working-tree changes out of the documentation commit.
