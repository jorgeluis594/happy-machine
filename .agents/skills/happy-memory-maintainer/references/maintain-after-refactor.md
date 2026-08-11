# Maintain Memories after Refactors

Treat every refactor or business-logic change as a mandatory memory review point. Review related knowledge without assuming that code movement invalidates it.

## Determine the Affected Knowledge

1. Identify the durable outcome of the change rather than recording work progress.
2. Identify the business rules, behaviors, constraints, decisions, procedures, components, and project terminology affected by the change.
3. Search active memories with specific related queries and a limit of `10` per search.
4. Keep the review scoped to the changed logic and its direct consequences.

Give business-logic memories deliberate attention even when the refactor primarily changes structure.

## Reconcile Each Memory

For every related memory:

- Leave it unchanged when its assertion remains correct and its metadata remains appropriate.
- Update it when the same idea changed partially or completely.
- Divide it when the change reveals independently evolving ideas.
- Rewrite it to state obsolescence when that current fact remains durable.
- Re-evaluate importance, confidence, and tags independently from the fact that a refactor occurred.

Register the durable outcome as new memory only when existing active knowledge does not already represent it.

## Guard the Lifecycle

Never delete a memory solely because code was refactored, moved, renamed, or removed. Never lower confidence mechanically after a refactor. Base confidence on evidence for the current assertion, including an assertion of obsolescence.

Complete the review only after related memories are either confirmed current, updated, divided, or deliberately left active with explicit current meaning.
