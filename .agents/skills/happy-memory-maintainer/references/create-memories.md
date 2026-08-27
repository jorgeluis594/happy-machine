# Create Memories

Create a memory when the candidate is durable, complete, atomic, has confirmed or reasonably plausible future reuse, and is not already represented by active project memory.

## Qualify Candidates

1. Restate each candidate as one context-independent idea.
2. Separate candidates that can change, score, tag, or disappear independently.
3. Exclude momentary work state, incomplete fragments, raw conversation, and incidental details without a reusable assertion.
4. Allow coherent uncertainty when it is explicit in the assertion and scored honestly; never present unsupported speculation as fact.
5. Identify the nature of the idea so the CLI type reflects meaning rather than topic.

Allow one consolidation point to produce multiple candidates. Keep each candidate on its own creation path.

## Check Existing Knowledge

1. Build a specific textual query from the candidate's canonical project terms.
2. Search related active memories with a limit of `10`.
3. Compare meaning, scope, and current state rather than relying only on exact text equality.
4. Route to update when an active memory represents the same idea but needs correction or refinement.
5. Do nothing when an active memory already represents the candidate adequately.

Do not create wording variants to bypass duplicate or semantic overlap.

## Build and Persist

1. Choose exactly one valid memory type.
2. Write a short discriminative title and self-contained content.
3. Assign importance and confidence independently.
4. Resolve a minimal keyword tag set from bounded vocabulary searches.
5. Construct one complete `create` operation per candidate.
6. Collect all ready candidate operations into the next batch, including a single operation when only one is ready.
7. Submit the batch through the mutation contract and inspect the ordered item result for every candidate.

A failed candidate does not undo successful creations in the same batch. Continue only with candidates and later operations that do not depend on the failed result.

## Finish the Case

Finish with one of these observable outcomes per candidate:

- Created and verified.
- Routed to update.
- Already represented, with no mutation.
- Failed with the CLI error preserved.
