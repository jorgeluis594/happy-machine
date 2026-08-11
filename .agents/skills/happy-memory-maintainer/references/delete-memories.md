# Delete Memories

Delete a memory when it should stop participating in active project knowledge and no current state of the same idea should replace it through update.

## Qualify Deletion

Require at least one of these conditions:

- Another active memory already preserves the same durable information completely.
- The memory is noise or was stored in error.
- The information belongs to a different scope and does not describe the active project.
- The memory is residue from a completed split and all durable parts are verified in atomic replacements.
- The information is invalidated and preserving its obsolescence has no durable future value.

Prefer update when the same idea has a corrected current state or when knowing its obsolescence remains useful.

## Reject Invalid Reasons

Do not delete solely because a memory is old, rarely used, low importance, low confidence, unrelated to the current task, or associated with refactored code. Do not infer deletion from search rank.

## Protect Information

1. Retrieve the current memory and version with `get`.
2. Re-check the qualifying condition against current evidence.
3. For duplication or division, inspect the retained active memories and confirm complete coverage.
4. Route to update if any durable current assertion should remain searchable.
5. Prepare a `delete` operation with the retrieved version as `expected_version`.
6. Add it to the next batch of ready operations, even when it is the only operation.
7. Submit the batch and inspect the corresponding ordered item result.

Remember that CLI deletion is logical: it removes the memory from active retrieval while preserving its revisions.

## Resolve Failures

- On `VERSION_CONFLICT`, retrieve the new state, reassess deletion, and retry it in a later batch once only if the criterion still holds.
- On missing, validation, or storage errors, preserve the failure and do not substitute another target.
- Never delete a related memory merely to make a failed deletion or creation succeed.
