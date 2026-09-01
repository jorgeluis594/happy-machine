# Codex YOLO State Launch Design

## Goal

Happy Machine must launch every workflow state that uses the Codex runtime with Codex's explicit unrestricted-execution flag. The behavior must not depend on, or modify, the user's global `~/.codex/config.toml`.

## Scope

The change applies to Codex commands created by the Orca task executor for normal workflow states, including states with an optional configured model, reasoning effort, or both.

The change does not apply to:

- OpenCode states;
- the shared Codex app-server, proxy, or remote TUI used by `create-skill`;
- global or project-local Codex configuration;
- recovery, cancellation, prompt delivery, or result handling.

## Design

`OrcaTaskExecutor.runtimeCommand()` remains the single owner of runtime command construction. For a Codex launch it will always start the command with:

```text
codex --dangerously-bypass-approvals-and-sandbox
```

Existing static and dynamic options remain in their current order after that prefix:

```text
codex --dangerously-bypass-approvals-and-sandbox
codex --dangerously-bypass-approvals-and-sandbox --model '<model>'
codex --dangerously-bypass-approvals-and-sandbox -c 'model_reasoning_effort="<reasoning>"'
codex --dangerously-bypass-approvals-and-sandbox --model '<model>' -c 'model_reasoning_effort="<reasoning>"'
```

Model and reasoning values continue to pass through the existing POSIX argument quoting. The new flag is a fixed literal owned by Happy Machine and introduces no new interpolation path.

OpenCode command construction remains unchanged.

## Behavioral Consequences

Every newly created Codex terminal for a workflow state runs with approval policy `never` and sandbox mode `danger-full-access`, regardless of the user's local Codex defaults. Explicit model and reasoning selections continue to work.

Already-running terminals are unaffected. The flag permits unrestricted filesystem and network access without approval prompts; this is intentional for Happy Machine-managed Codex states.

This decision supersedes the earlier state-launch behavior that inherited sandbox and approval settings entirely from the local Codex configuration.

## Error Handling

No new error path is required. Orca terminal creation and existing `TaskExecutorError` handling continue to report command-launch failures. If the installed Codex version does not recognize the flag, the terminal will fail through the existing execution and result-observation flow.

## Verification

Update the Orca task executor tests to assert the exact YOLO prefix for Codex launches with:

- no optional settings;
- model only;
- reasoning only;
- model and reasoning together;
- adversarial model and reasoning values.

Keep the existing OpenCode assertions unchanged and confirm prompt content is still excluded from the shell command. Run the focused Orca executor tests, then the repository lint-fix, full test suite, and typecheck required by the implementation workflow.
