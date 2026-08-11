# Task 03: Snapshot definitions, agents, prompts, and run inputs

## Objective

Create a durable, immutable copy of the complete executable definition and the user-selected Markdown documents at the start of each run, and provide the first agent with a stable context.md.

## Functional value

A run preserves exactly the rules and inputs with which it started. Later changes to the project or original files cannot silently alter active work or prevent an operator from explaining what information the agent received.

## Dependencies

- Task 02.

## Scope

- Support zero or more --input options on execute.
- Require each input to be an existing, readable Markdown file.
- Permit inputs outside the project root only when explicitly supplied through --input.
- Copy all inputs into the run's immutable store before starting the initial state.
- Support duplicate basenames by assigning each input a stable internal ID.
- Snapshot happy-machine.yaml, effective project configuration, workflow, effective policies, all referenced agent instructions, inline or file prompts, resolved agents and models, overrides, and inputs.
- Exclude secrets supplied through the environment; persist only declarative configuration and model identifiers.
- Do not copy the complete source tree as part of the definition snapshot.
- Assign a verifiable identity to the snapshot and associate it durably with the run.
- Generate an immutable context.md for the first visit containing an index of every input and its stable internal path.
- Use paths equivalent to inputs/{input-id}/{original-name}.md without basename collisions.
- Materialize context.md and the other control paths before launching the attempt.
- Ensure agents read durable copies rather than the original input files.

## Out of scope

- Including documents produced by earlier states; that belongs to Task 04.
- Exposing resume; that belongs to Task 10, although the snapshot must already support future resume.
- Copying or freezing the project source tree.
- Persisting secrets in an attempt to reproduce the external environment.
- Semantically selecting or summarizing the indexed documents.

## Acceptance criteria

1. **External input allowed:** Given a readable Markdown file outside the project passed through --input, when the run is created, then the file is copied into durable storage and the first context.md references the immutable copy.
2. **Implicit external path forbidden:** Given a configuration path that escapes the root without being an explicit --input, when execute runs, then it is rejected before creating the run.
3. **Input validation:** Given a missing, unreadable, nonregular, or non-Markdown input, when execute runs, then it fails with exit code 1 before starting the agent.
4. **Duplicate basenames:** Given two inputs named brief.md in different directories, when the snapshot is created, then both appear exactly once in context.md with distinct IDs and internal paths.
5. **Input immutability:** Given an already-created run, when the original input is changed or removed before the agent reads it, then the agent still sees the content captured during run creation.
6. **Definition immutability:** Given an already-created run, when the workflow, configuration, instructions, prompt, or default model changes, then the run snapshot does not change and a new execute captures the edited version.
7. **Complete snapshot:** Given a valid workflow, when its snapshot is inspected, then it contains all and only the declarative artifacts listed in scope together with their effective values.
8. **Secrets excluded:** Given a secret available in the executor environment, when the snapshot is created, then the value does not appear in the durable database, snapshot files, context.md, or events.
9. **Stable context:** Given the initial state, when multiple attempts run for the same visit, then the context.md path and content remain immutable.
10. **Preparation order:** Given a valid input, when launch is observed, then the durable copy and complete snapshot exist before Orca is invoked.

## Required tests

- Integration tests with internal, external, duplicate, invalid, and mid-run modified inputs.
- Snapshot test with an inline prompt and another with prompt_file.
- Snapshot test with a model override and effective policies.
- Nonleakage test that injects a sentinel secret into the environment and searches every persisted artifact for it.
- End-to-end test proving the agent receives the copied content rather than the modified original.

## Traceability

- PRODUCT.md: Invariant 5.1; Sections 6.1–6.2, 7.2, 10.1–10.4, 11, 19.4, and 22.2.
- Normative scenarios: 25.13 and 25.14.

## Definition of done

- Acceptance criteria are automated with fixtures that modify originals after run creation.
- The snapshot has a stable identity and can be audited without access to the original files.
- context.md contains only durable references and does not leak secrets.
- Execution without --input remains valid.
