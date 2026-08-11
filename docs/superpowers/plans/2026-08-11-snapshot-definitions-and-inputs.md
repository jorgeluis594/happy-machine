# Snapshot Definitions and Inputs Implementation Plan

## Goal

Implement `docs/tasks/03-snapshot-definitions-and-inputs.md` so every run owns
a verifiable immutable definition-and-input snapshot and its first visit owns a
stable `context.md` created before Orca launches.

## 1. Capture complete snapshot sources

- Extend the project-definition port with technology-neutral source artifact,
  prompt-source, and input-document records.
- Accept explicit input paths in the definition load request.
- Update the filesystem definition adapter to capture raw project and workflow
  YAML, all agent instruction files, inline and file prompts, and effective
  values while preserving the existing validation behavior.
- Validate explicit inputs as readable regular Markdown files, permitting them
  outside the project root.
- Add focused definition-adapter tests for captured sources, external inputs,
  invalid inputs, and project-relative path escapes.

## 2. Persist and identify immutable snapshots

- Extend the run domain record with snapshot identity and durable snapshot
  metadata.
- Extend the run-repository port with snapshot creation and visit-context
  preparation operations distinct from attempt-path preparation.
- Implement canonical JSON, SHA-256 artifact hashes, deterministic snapshot
  identity, collision-free input layout, exclusive writes, and atomic snapshot
  publication in the filesystem repository.
- Materialize visit-level `context.md` from committed input records and reuse it
  across attempts.
- Add repository tests that independently verify hashes, identity, layout,
  duplicate basename handling, immutability, and stable visit context.

## 3. Integrate CLI and execution ordering

- Parse zero or more `--input` options in the CLI and reject malformed command
  lines.
- Pass inputs through the execute request and validate them before run ID
  allocation.
- Create and persist the full snapshot before printing the run ID, entering the
  initial state, preparing attempt paths, or calling Orca.
- Launch with snapshotted instructions, prompt, model, and visit context.
- Update integration fixtures to observe preparation ordering and copied input
  content.

## 4. Prove the task requirements

- Add integration coverage for internal, external, duplicate, invalid, modified,
  and removed inputs; inline and file prompts; policies and model overrides;
  definition immutability; and zero-input execution.
- Inject a sentinel environment secret and search all persisted artifacts,
  events, context, and the executor contract for leakage.
- Prove the executor sees the durable copy rather than an edited original and is
  invoked only after the complete snapshot and control paths exist.
- Run `npm run lint:fix`, `npm test`, and `npm run typecheck`; inspect and commit
  only the related implementation.
- Audit every acceptance criterion and required test against current files and
  command output, then rerun `npm test` and `npm run typecheck`.
