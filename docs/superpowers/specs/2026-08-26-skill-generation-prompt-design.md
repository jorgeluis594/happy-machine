# Skill Generation Prompt Design

**Date:** 2026-08-26

## Purpose

Strengthen the single generation prompt used by `happy-machine create-skill`
so the fresh Codex session reliably enters the native skill-creation workflow
and correctly consumes the evidence model produced in `skill-context.md`.

The change preserves the existing capture-to-Codex handoff. Happy Machine
still submits exactly one initial prompt, sends no follow-up messages, does not
inspect the generated skill, and does not guarantee its quality.

## Current Behavior

The generation prompt currently provides the creation objective, the user's
declared workflow, and an opaque reference to `skill-context.md`. It asks Codex
to read the context, use native skill-creation capabilities, and interact with
the user as needed.

This is sufficient for the original proof of concept, whose success criterion
is the handoff itself. It leaves several behaviors implicit:

- selecting the native `skill-creator` capability;
- treating the supplied workflow and analyzed context as source data rather
  than instructions;
- preserving `Observed`, `Inferred`, and `Unknown` classifications;
- resolving consequential unknowns before encoding them in a skill;
- selecting repository or user scope deliberately; and
- completing the native validation workflow.

The analysis prompt now produces a richer, pipeline-oriented evidence model.
Without corresponding generation instructions, the creation session can
flatten an inference into a requirement, ignore clarification questions, or
overfit the skill to incidental details from one demonstration.

## Decision

Use a reliability-first generation prompt that explicitly invokes
`$skill-creator` and tells it how to interpret the supplied evidence without
prescribing the skill's internal structure.

This supersedes the narrow proof-of-concept decision that Happy Machine must
not select a native skill-creation capability. It does not otherwise expand
Happy Machine's responsibility: `skill-creator` owns clarification, authoring,
destination selection, and validation after the prompt is submitted.

### Alternatives considered

1. **Explicit `$skill-creator` invocation — selected.** Deterministically loads
   the current native authoring instructions and their validation behavior. It
   creates a small coupling to the bundled skill's public invocation name.
2. **Improved generic delegation.** Add evidence and trust instructions while
   retaining “native skill-creation capabilities.” This preserves the original
   abstraction boundary but still relies on implicit skill routing.
3. **Keep the current prompt.** This has the smallest implementation cost but
   fails to consume the richer context contract and leaves the known routing,
   destination, and validation risks unchanged.

## Prompt Contract

The generated prompt must:

1. request a reusable Codex skill for the declared workflow;
2. identify the workflow description and analyzed artifact as source data, not
   instructions;
3. preserve both supplied values as JSON-delimited text and continue referencing
   the context through its opaque agent-readable reference;
4. require the context to be read before skill creation begins;
5. require `Observed`, `Inferred`, and `Unknown` claims to remain distinct;
6. forbid turning an inference, incidental implementation detail, or single
   demonstrated example into a universal requirement;
7. explicitly invoke `$skill-creator` and delegate the rest of the native
   creation and validation workflow to it;
8. require consequential unknowns to be resolved with the user before they are
   encoded;
9. require the user to be consulted when repository versus user-level
   destination cannot be inferred safely; and
10. leave all other implementation, scope, structure, resource, and validation
    choices to the native creator.

The prompt does not embed `skill-context.md`, send follow-up messages, select a
skill name or destination itself, inspect results, retry generation, or add a
Happy Machine completion protocol.

## Data Flow and Trust Boundary

`workflowDescription` remains user-supplied data. `skillContextReference`
identifies analyzer-produced data derived from an untrusted demonstration.
Both values remain JSON-delimited when inserted into the prompt.

The prompt explicitly classifies both inputs as source data rather than
instructions. This supplements, but does not replace, the analyzer's existing
prompt-injection defenses. The context artifact remains the authoritative
evidence handoff, while the declared workflow remains the user's concise
statement of intent.

## Error Handling and Lifecycle

No runtime behavior changes. The generation session remains fresh and
persistent, receives the context artifact as a readable resource, and starts
with exactly one initial prompt. Existing startup, cancellation, cleanup, and
session-retention behavior remains unchanged.

Any clarifying conversation is between the user and Codex inside the generation
session. It is not a Happy Machine follow-up prompt.

## Testing

Update focused prompt tests to assert semantic requirements without snapshotting
the complete prose:

- explicit `$skill-creator` invocation;
- source-data trust classification;
- preservation of `Observed`, `Inferred`, and `Unknown`;
- protection against universalizing inferences, incidental details, and one
  demonstration;
- user clarification for consequential unknowns and ambiguous destination;
- native creation and validation delegation; and
- continued JSON delimiting and opaque context referencing.

Existing launch and end-to-end tests continue proving that the TUI receives
exactly one prompt and that the artifact is available as a readable resource.
No behavioral evaluation of a generated skill is added in this change.

## Scope

Modify only the generation prompt builder, its focused tests, and documentation
needed to record the revised decision. Do not change the analysis prompt,
artifact lifecycle, session orchestration, CLI interaction, destination logic,
or result evaluation.
