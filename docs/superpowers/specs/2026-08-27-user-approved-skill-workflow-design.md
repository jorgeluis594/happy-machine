# User-Approved Skill Workflow Design

**Date:** 2026-08-27

## Purpose

Strengthen the generation prompt used by `happy-machine create-skill` so the
fresh Codex session confirms its understanding of the user's workflow before
creating the skill.

The confirmation is a concise design review of what the user's workflow does.
It is not a review of the skill's files or internal implementation.

## Current Behavior

The generation prompt tells Codex to read the analyzed workflow context,
preserve its evidence classifications, resolve consequential unknowns with the
user, and complete `$skill-creator`'s native creation and validation workflow.
It does not explicitly require Codex to show the reconstructed workflow to the
user or obtain approval before authoring the skill.

Consequently, Codex can begin creation with an incorrect or incomplete model
of the workflow even when no individual unknown appears consequential enough
to trigger a clarification question.

## Decision

Add an explicit pre-creation approval gate to the generation prompt. After
reading the analyzed context and resolving any clarifications needed to
describe the workflow, Codex must:

1. present a concise summary of the proposed workflow design;
2. explain the workflow's objective, main stages, the user's role, and expected
   result;
3. ask the user for explicit approval;
4. incorporate requested corrections and present the revised summary again;
   and
5. create the skill only after the user approves the summarized workflow.

The summary describes the user's operational flow. It must not expand into a
detailed skill implementation proposal unless `$skill-creator` independently
needs that detail later in its native creation process.

## Alternatives Considered

### Optional confirmation

Ask Codex to confirm the workflow “when useful.” This is smaller but leaves the
desired interaction discretionary and does not reliably prevent premature
authoring.

### Post-creation review

Create the skill first and then ask the user whether its workflow is correct.
This gives the user something concrete to inspect but creates avoidable rework
when Codex misunderstood the workflow.

### Pre-creation approval gate — selected

Validate the concise workflow design before authoring. This catches conceptual
errors at the cheapest point while keeping Happy Machine's orchestration and
the native `$skill-creator` workflow unchanged.

## Interaction Flow

```text
Declared workflow + analyzed context
                  |
                  v
       Codex reconstructs the flow
                  |
                  v
 Concise workflow-design summary to user
                  |
          +-------+-------+
          |               |
     corrections       approval
          |               |
          +--> revise     v
                      create skill
                           |
                           v
                 native skill validation
```

Approval must be explicit. Silence, an unanswered question, or Codex's own
assessment does not satisfy the gate.

## Prompt Contract

The existing generation-prompt contract remains in force. The new language
must additionally require Codex to:

- summarize what the user's workflow consists of before creating files;
- keep the summary concise and centered on objective, main stages, user role,
  and expected result;
- request explicit user approval of that summary;
- revise and re-present the summary when the user corrects it; and
- refrain from creating the skill until approval is received.

The approval gate does not replace existing requirements to preserve
`Observed`, `Inferred`, and `Unknown` classifications, resolve consequential
unknowns, select destination scope safely, or complete `$skill-creator`'s
native validation workflow.

## Architecture and Lifecycle

Only `buildGenerationPrompt()` changes. Happy Machine still sends exactly one
initial prompt and does not add follow-up turns, inspect the resulting skill,
or enforce approval in application code. The subsequent design review and
approval conversation occurs between Codex and the user inside the persistent
generation session.

No changes are required to the analysis prompt, captured artifacts, session
ports, adapters, CLI, or cleanup lifecycle.

## Error and Correction Handling

If the user rejects or corrects the summary, Codex must revise its workflow
model and request approval again. If the user has not approved, creation remains
blocked in the generation conversation; Happy Machine does not interpret that
state or attempt recovery.

Existing behavior for missing context, session startup failures, cancellation,
and cleanup remains unchanged.

## Testing

Update the focused generation-prompt tests to assert semantically that the
prompt:

- requires a concise workflow summary before skill creation;
- names the objective, main stages, user role, and expected result as its
  contents;
- requests explicit approval from the user;
- requires correction and renewed presentation after rejection or feedback;
- prohibits skill creation before approval; and
- still delegates post-approval authoring and validation to `$skill-creator`.

Do not snapshot the complete prompt. Existing tests continue covering trust
boundaries, evidence classifications, JSON delimiting, opaque context
references, single-prompt launch behavior, and artifact availability.

## Scope

Modify only the generation prompt, its focused tests, and documentation that
records the revised contract. Do not change the analysis prompt, application
orchestration, session protocol, CLI interaction, destination behavior, or
runtime evaluation of generated skills.
