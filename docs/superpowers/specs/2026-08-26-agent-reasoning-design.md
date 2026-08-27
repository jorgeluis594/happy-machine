# Agent Reasoning by Profile

## Summary

Happy Machine accepts an optional, open-ended `reasoning` string on each agent
profile in `happy-machine.yaml`. The value is inherited only through the
selected profile, applies to both supported runtimes, and becomes part of the
immutable effective definition stored in every new run snapshot.

## Configuration Contract

`project.agents.<id>.reasoning` is optional and must be a non-empty string when
present. Happy Machine does not interpret the value as an enum or validate it
against the selected model or runtime. Invalid values reported by Codex or
OpenCode follow the existing technical-failure and retry behavior.

States and parallel tasks continue to select a registered profile through
`agent`. They cannot override `reasoning`, just as they cannot override
`runtime`.

```yaml
agents:
  implementation:
    instructions: agents/implementation.md
    runtime: codex
    reasoning: high

  review:
    instructions: agents/review.md
    runtime: opencode
    reasoning: max
```

The public definitions carry the resolved value:

```ts
interface AgentDefinition {
  id: string;
  instructions: string;
  runtime: "codex" | "opencode";
  reasoning?: string;
}

interface TaskLaunch {
  // Existing fields remain unchanged.
  runtime: "codex" | "opencode";
  reasoning?: string;
}
```

## Execution

When `reasoning` is absent, the Orca adapter preserves the existing command
exactly: `codex` or `opencode`.

When it is present, the adapter constructs these logical commands:

- Codex: `codex -c 'model_reasoning_effort="<value>"'`
- OpenCode: `opencode run --interactive --variant '<value>'`

The adapter serializes the Codex value as a TOML basic string and applies POSIX
single-argument quoting to every dynamic shell argument. It never interpolates
the raw configuration value into a command. Spaces, quotes, command
substitutions, backticks, and newlines therefore remain literal data.

Execution attempts copy the resolved profile value into `TaskLaunch`. Retries
reuse it, and durable recovery rebuilds it from the snapshotted effective
definition rather than rereading project configuration.

## Snapshots and Compatibility

Because `reasoning` is present in agent profiles embedded throughout the
effective definition, it is written to `effective.json` and `manifest.json` and
contributes to the canonical snapshot identity. Changing only `reasoning`
therefore changes the identity of a newly created snapshot.

No snapshot format bump is required. JSON optional fields are backward
compatible, and older snapshots load with `reasoning` absent while retaining
the existing missing-runtime normalization to Codex.

## Validation and Tests

Tests cover accepted Codex and OpenCode profile values; empty, non-string, and
state/task override rejection; exact unchanged commands when omitted; both
configured commands; adversarial shell-like values; propagation through normal
execution, retries, and recovery; snapshot content and identity; and legacy
snapshot loading.

README and product documentation describe profile-scoped reasoning selection
and clarify that model selection and all other CLI behavior remain locally
configured.
