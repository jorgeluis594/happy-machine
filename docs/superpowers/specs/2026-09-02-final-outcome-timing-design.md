# Final Outcome Timing Design

## Goal

Make the Happy Machine agent prompt explicitly require agents to generate and
write their outcome only after the entire assigned task is complete, including
all implementation and validation work.

## Design

Add a normative instruction to the `Happy Machine result contract` emitted by
the Orca task executor. The instruction will state that `result.json` may be
generated and written only after all assigned implementation and validation
have finished, and that writing it must be the final task action.

Keep this rule adjacent to the existing `result.json` schema and routing rules
so agents encounter it at the point where they learn how to report an outcome.
Do not change workflow routing, result parsing, persistence, or validation
behavior.

## Validation

Update the Orca task-executor prompt test to assert the new timing instruction.
Run the focused test, then the repository lint, test, and typecheck commands
required by the implementation workflow.

## Compatibility and Failure Behavior

The change affects prompt guidance only. Existing valid result files remain
compatible. If an agent ignores the instruction and writes a result early,
Happy Machine's existing result handling remains unchanged.
