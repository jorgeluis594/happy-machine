# Happy Machine-Owned Terminal Prompts

## Goal

Happy Machine must own the complete prompt lifecycle while Orca acts only as a terminal-control transport. The configured state prompt must reach Codex unchanged as the user message. Orca orchestration concepts and injected coordination text must not enter the Codex session.

## Prompt ownership

Happy Machine separates the Codex input into native channels:

- The configured agent instructions and the Happy Machine result contract are supplied as Codex `developer_instructions`.
- The configured state `prompt` is sent unchanged as the Codex user message.

The developer instructions include the project workspace, context path, output directory, exact `result.json` path, allowed outcomes, and the requirement that only the validated result file controls workflow routing. This preserves the operational contract without prepending or appending text to the configured user prompt.

Orca must not generate, wrap, interpret, or retain prompt content. It only transports the already-separated Codex inputs by starting the terminal and sending the user message.

## Launch sequence

Each attempt uses this sequence:

1. Happy Machine builds the Codex developer instructions and command.
2. Happy Machine calls `orca terminal create` in the current worktree with the configured model, no sandbox, and `--focus`.
3. Happy Machine decodes the returned terminal handle and persists it immediately as the attempt's external identity.
4. Happy Machine waits exactly 8,000 milliseconds using the existing cancelable, test-injectable delay.
5. Happy Machine calls `orca terminal send --terminal <handle> --text <configured-prompt> --enter --json`.
6. Happy Machine monitors the result file and terminal metadata until a valid completion, failure, cancellation, or timeout is observed.
7. The application validates `result.json` and applies the existing workflow transition rules.

The launch path must not call any `orca orchestration` command. In particular, it removes `run-create`, `task-create`, `dispatch --inject`, `check`, `worker-read`, `worker-show`, and `worker-stop`.

## External identity and compatibility

The active Orca identity is the terminal handle. New attempts persist terminal-only references and do not manufacture Task, Run, or Dispatch identifiers.

The durable run representation must continue reading legacy references from runs created by earlier Happy Machine builds. Legacy fields may remain optional for deserialization compatibility, but new terminal-only attempts do not populate or depend on them. Events and diagnostics correlate new attempts through the Happy Machine attempt identity and terminal handle rather than a Dispatch ID.

The port contract remains technology-independent: it represents an external execution handle and optional legacy references, not Orca orchestration entities.

## Completion and monitoring

The result file remains the sole authority for workflow outcomes. Happy Machine watches for the assigned `result.json`, then relies on the existing application validation for JSON shape, allowed outcome, document paths, and routing.

While waiting, Happy Machine uses terminal-only operations:

- `terminal read` for debug transcript collection;
- `terminal show` for liveness and recovery checks;
- `terminal close` for cancellation and startup cleanup.

No `terminal wait --for tui-idle` completion heuristic is required. An idle Codex TUI is not treated as success because it may be waiting for user input. If the terminal disappears before a usable result is produced, the attempt fails with diagnostic context instead of assuming success.

Questions remain visible and answerable directly in the focused Codex tab. Happy Machine no longer converts Orca question or escalation messages into structured workflow events.

## Recovery and cancellation

Because the terminal handle is persisted immediately after creation, recovery can inspect that terminal after a Happy Machine restart. Recovery evaluates the existing result file first, then terminal liveness:

- a valid result is completed;
- a live terminal without a valid result is active;
- a missing or exited terminal without a valid result is failed or stopped according to the calling recovery path;
- an unreadable terminal state is unknown and preserves the existing safety behavior.

Cancellation closes only the persisted terminal for that attempt and then confirms through terminal metadata that it is no longer active. Startup failures or cancellation during the eight-second delay close only the newly created terminal. There is no orchestration fallback.

## Error handling

Happy Machine validates JSON responses from `terminal create`, `terminal send`, `terminal show`, `terminal read`, and `terminal close`. Invalid JSON, missing handles, mismatched handles, unsuccessful Orca envelopes, terminal disappearance, and result-file validation errors retain stdout and stderr in the attempt logs.

If prompt delivery fails, Happy Machine closes the newly created terminal and reports launch failure. If monitoring fails after the terminal identity has been persisted, the existing timeout, cancellation, and reconciliation safeguards apply.

## Testing

Automated tests must cover:

- exact ordering: terminal creation, 8,000-millisecond delay, prompt send, result monitoring;
- the configured prompt passed byte-for-byte to `terminal send`;
- agent instructions and the result contract passed through Codex `developer_instructions`, separately from the user prompt;
- configured model, focus behavior, no-sandbox mode, and safe shell escaping;
- absence of every `orca orchestration` invocation and every `worker-*` command;
- terminal-only diagnostics, cancellation, reconciliation, and recovery;
- cleanup when cancellation or failure occurs before prompt delivery;
- invalid JSON and unsuccessful envelopes from terminal commands;
- missing, malformed, disallowed, and successful result files;
- compatibility when reading durable runs containing legacy orchestration references;
- existing workflow completion, failure, timeout, recovery, and diagnostic regressions.

The implementation must pass `npm run lint:fix`, `npm test`, and `npm run typecheck`, followed by a build of the globally linked CLI.

## Non-goals

- Happy Machine will not use Orca Tasks, Runs, Dispatches, mailboxes, capabilities, heartbeats, questions, escalations, or `worker_done`.
- Happy Machine will not infer success from terminal output or TUI idleness.
- This change does not alter the public Happy Machine CLI or workflow file format.
- The fixed eight-second startup delay remains a proof-of-concept readiness delay rather than a formal Codex-ready signal.
