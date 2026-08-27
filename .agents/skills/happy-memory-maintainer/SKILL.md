---
name: happy-memory-maintainer
description: "Autonomously maintain durable, atomic repository memories through the happy-memory CLI by creating, updating, splitting, soft-deleting, and curating keyword tags. Use automatically during repository work at natural consolidation points when a durable fact, decision, constraint, preference, procedure, lesson, correction, refactor outcome, or business-logic change appears; and use when the user explicitly asks to add, edit, delete, reorganize, audit, or retag project memories."
---

# Maintain happy-memory Knowledge

Maintain broad durable project knowledge without turning memory into an activity log.

## Define Durable Information

Treat information as durable when it is expected to outlast the current task or conversation and may reasonably help future project work.

Require durable information to:

- Relate to the project, product, architecture, workflow, or applicable preferences.
- Express at least one complete idea outside its original conversational context.
- Describe reusable project knowledge rather than the momentary state of work.

Do not require immediate relevance, known future impact, or demonstrated prevention of rediscovery. Keep durability separate from certainty and impact: state uncertainty explicitly, represent it with confidence, and represent the consequence of forgetting with importance. Low importance or confidence does not independently disqualify an otherwise eligible memory.

## Preserve Atomicity

Store one independently reusable idea per memory. Keep only the context, rationale, or steps that are inseparable from that idea.

Split information when its parts can change independently, have different types, need different importance or confidence, need different tags, or can be removed independently. A consolidation point may produce several memories. Never combine independent ideas merely to reduce commands.

## Consolidate Autonomously

Observe all complete durable candidates during work and maintain them at natural consolidation points: after confirming durable knowledge, correcting a prior belief, completing a refactor or logic change, or before handing off reusable knowledge.

Decide autonomously whether to create, update, divide, delete, or do nothing. Do not request confirmation for a qualifying mutation. Limit discovery and maintenance to knowledge related to the current work.

## Route the Case

Read only the references required by the detected case:

| Detected case | Read |
| --- | --- |
| New durable information | [create-memories.md](references/create-memories.md) |
| Correction, evolution, or division | [update-memories.md](references/update-memories.md) |
| Removal from active knowledge | [delete-memories.md](references/delete-memories.md) |
| Refactor or business-logic change | [maintain-after-refactor.md](references/maintain-after-refactor.md) |
| Assigning or revising scores | [score-memories.md](references/score-memories.md) |
| Selecting or maintaining keywords | [maintain-tags.md](references/maintain-tags.md) |
| Writing or rewriting searchable text | [write-retrievable-memories.md](references/write-retrievable-memories.md) |
| Running any happy-memory command | [cli-contract.md](references/cli-contract.md) |

For creation, load creation, scoring, tags, retrievable writing, and CLI contract. For update or division, load update plus every affected supporting case. For deletion, load deletion and the CLI contract. For a refactor, load the refactor case first, then load only the mutation cases it identifies.

## Run the Maintenance Cycle

1. Collect complete durable candidates at the consolidation point.
2. Split independent ideas before searching or scoring.
3. Load the references routed for the case.
4. Search only related active memories and tag vocabulary.
5. Choose create, update, divide, delete, or no change for each candidate.
6. Prepare all mutation operations whose inputs and safety conditions are known.
7. Submit the ready operations with `happy-memory batch --input -`, even when there is exactly one operation.
8. Verify the process exit, the batch envelope, and every ordered item result.
9. Submit dependent operations in later batches only after their prerequisites succeed.
10. Leave unrelated correct memories unchanged.

Use `batch` as the only mutation path. Batching does not change memory atomicity and does not provide an all-or-nothing transaction: preserve every item outcome and continue only with operations that do not depend on failed items.

If a command fails because `happy-memory` is unavailable or cannot be found on `PATH`, read [install-cli.md](references/install-cli.md) for installation steps before retrying. Do not load that reference for other failures.
