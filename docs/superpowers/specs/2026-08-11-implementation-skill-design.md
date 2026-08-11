# Implementation Skill Design

## Purpose

Create a project-local skill named `implementation` that governs implementation work as a continuous development process with validated, meaningful commits.

The skill must not divide the entire task into predefined functional increments. Instead, it must evaluate the current changes throughout implementation and create a commit whenever those changes have become a coherent, validated unit.

## Location and Contents

Create the skill at `.agents/skills/implementation/` with:

- `SKILL.md`, containing the complete implementation workflow.
- `agents/openai.yaml`, containing the user-facing skill metadata.

The skill does not require scripts, references, or assets. All skill content and metadata must be written in English.

## Triggering Scope

Trigger the skill for requests that authorize implementing, changing, fixing, or refactoring project code. Do not trigger it for analysis-only, planning-only, explanation, review, or status requests that do not authorize code changes.

## Context and Architecture Analysis

Before editing code, the skill must require the agent to:

1. Read `docs/ARCHITECTURE.md` completely.
2. Inspect the requested behavior, relevant source code, tests, configuration, and repository conventions.
3. Inspect Git status and preserve unrelated or pre-existing user changes.
4. Identify how the requested behavior fits the current architectural layers and dependency rules.
5. Determine the project's test and type-check commands.

For this project, the required full validation commands are `npm test` and `npm run typecheck`.

The analysis may identify likely implementation areas, but it must not freeze the work into a predefined sequence of commits.

## Continuous Implementation Flow

Implementation proceeds continuously:

1. Make the changes required by the requested behavior while following the existing architecture.
2. Add or update tests alongside the behavior they verify.
3. Run focused tests as useful during development.
4. Reassess the accumulated changes whenever a natural boundary emerges.
5. If the changes pass the commit-readiness gate, run the full validation gate and commit them.
6. Continue implementing the remaining requirements and repeat the assessment.

Changes that still depend on immediate follow-up work to be meaningful must remain uncommitted until the coherent behavior is complete.

## Commit-Readiness Gate

The accumulated implementation changes are ready for a commit only when all of these conditions are true:

- They satisfy a coherent portion of the requested requirements.
- They are independently understandable and safely reversible.
- They contain no deliberately incomplete or broken behavior.
- They comply with `docs/ARCHITECTURE.md` and existing project conventions.
- They include the tests needed to prove the behavior.
- Their diff has one clear meaning that can be stated in a concise commit message.
- They do not include unrelated user changes.

The number of files or architectural layers touched does not determine the boundary. A cross-layer change belongs in one commit when all touched pieces are required to deliver one coherent behavior.

## Validation and Commit Gate

Before every commit, the skill must require the agent to:

1. Run `npm test`.
2. Run `npm run typecheck`.
3. Fix every failure caused by the current changes and rerun the failing validation.
4. Inspect Git status and the final diff.
5. Stage only the files belonging to the coherent change.
6. Create a concise commit whose message describes the completed meaning of the change.

The agent must not create the commit or continue to another implementation area while either required validation fails. If a pre-existing failure prevents a clean validation gate, the agent must report the evidence and ask the user how to proceed rather than representing the change as validated.

## Failure and Repository Handling

- If architecture and requested behavior appear to conflict, adapt the design to the documented architecture. Ask the user only when the conflict cannot be resolved without changing scope or architecture.
- If a meaningful change cannot be separated safely, keep its related edits together until the whole behavior passes the readiness gate.
- If Git is unavailable, stop before implementation and report that the required commit workflow cannot be fulfilled.
- If a commit fails, preserve the validated work, diagnose the failure, and retry only after resolving it safely.
- Never discard, overwrite, stage, or commit unrelated user changes.

## Completion

After all requested behavior is implemented, run `npm test` and `npm run typecheck` once more. Confirm that every requested requirement is covered, inspect the remaining Git status, and report the commits created and the final validation result.

## Skill Validation

Validate the finished skill with the `skill-creator` `quick_validate.py` script. The skill is complete when its structure and metadata pass validation and its instructions encode the continuous commit-readiness workflow above without placeholders or contradictory rules.
