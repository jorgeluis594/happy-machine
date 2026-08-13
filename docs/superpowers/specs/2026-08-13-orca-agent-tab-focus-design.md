# Orca Agent Tab Focus Design

## Purpose

Happy Machine-created Codex terminals should be revealed as the active Orca tab instead of remaining collapsed under the worktree's background-terminal indicator.

## Design

Add Orca's `--focus` flag to the existing `terminal create` invocation. The launch sequence remains `run-create`, `task-create`, `terminal create`, an eight-second delay, `dispatch --inject`, and `check`; focusing changes only Orca presentation and does not send task input early.

The terminal still starts Codex with the configured model and without the Codex sandbox. Orca continues to inject its coordination preamble before the Happy Machine task specification, so the configured agent instructions and workflow prompt remain available as `TASK.instructions` and `TASK.prompt`.

## Validation

The Orca adapter test must verify the exact `terminal create` arguments include `--focus`, while retaining the existing assertions for command escaping, operation order, the eight-second delay, and the absence of `worker-start` and `terminal wait`.

No public Happy Machine CLI or configuration changes are introduced.
