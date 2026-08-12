# Agent Result Contract Injection Design

## Goal

Happy Machine automatically appends the structured result contract to every
agent prompt. Workflow authors continue to provide only the task prompt; they
do not need to repeat engine protocol instructions.

## Architecture

`TaskLaunch` carries the immutable list of semantic outcomes allowed for the
attempt. `ExecuteWorkflow` derives that list from the snapshotted normal
state's outcome keys and uses the fixed `succeeded` and `failed` outcomes for
parallel tasks. `RecoverWorkflow` derives the same values from the same
snapshotted definition for new attempts started during recovery.

The Orca outbound adapter preserves `instructions` and the original `prompt`
in `TaskLaunch`. At the external boundary it constructs the effective prompt
by appending a generated result-contract block to the original prompt. The
block identifies the exact `result.json` path and output directory, lists only
the allowed semantic outcomes, describes the required `outcome`, `documents`,
and optional `error` fields, requires Markdown documents with paths relative
to the output directory, and states that only `result.json` controls workflow
routing. It does not expose outcome destination states.

## Validation and Recovery

Existing result validation remains authoritative. Missing or malformed
results, unknown outcomes, and invalid document references remain technical
attempt failures. Retries rebuild the same contract from the immutable work
definition. Recovery does the same when it must relaunch an absent attempt;
already active or completed external work is observed without changing its
original launch.

No workflow YAML or persisted run schema changes are required. Contract
injection is mandatory for all newly launched attempts.

## Testing

Adapter tests inspect the Orca task spec and verify that the original prompt is
followed by the generated contract, exact paths and outcomes are present, and
destination state names are absent. Workflow tests verify normal, parallel,
retry, and recovery launches receive the expected `allowedOutcomes`. Existing
result-validation tests continue to cover malformed and unknown results.
