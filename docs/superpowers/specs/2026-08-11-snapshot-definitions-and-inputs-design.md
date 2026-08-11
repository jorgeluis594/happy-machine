# Snapshot Definitions and Inputs Design

## Purpose

Each run must preserve the complete declarative definition and every explicit
Markdown input exactly as they existed when execution began. Agents must use
those durable copies so later edits or deletion of source files cannot change
an active run or make it unauditable.

## Boundaries

The existing project-definition adapter remains responsible for discovering
the project, validating all project-relative paths, reading declarative source
files, and resolving effective agents, prompts, models, policies, states, and
overrides. It will also validate and read the explicitly supplied CLI inputs;
unlike configuration references, those paths may be outside the project root.

The application use case will coordinate this sequence:

1. Load and validate the complete definition and every input without allocating
   a run.
2. Allocate the run identity in memory.
3. Ask the run repository to atomically create the immutable snapshot.
4. Associate the returned snapshot identity and paths with the run, persist the
   run, and print its ID.
5. Create the initial visit context and attempt control paths.
6. Launch Orca using only the resolved values and durable paths returned by the
   snapshot operation.

The filesystem run repository owns snapshot layout, hashing, atomic writes,
immutable context materialization, and the translation from technology-neutral
snapshot data to files. No filesystem or cryptography APIs cross into the
application or domain layers.

## Loaded Definition and Artifact Model

The project-definition port returns the effective execution definition plus a
closed snapshot source containing:

- The original `happy-machine.yaml` bytes.
- The original workflow bytes.
- Every registered agent instruction file's bytes.
- Every state and parallel-task prompt, recording whether it was inline or read
  from a prompt file.
- The fully resolved effective definition, including executor, workspace mode,
  agents, models, model overrides, policies, states, tasks, outcomes, and the
  initial state.
- Every validated explicit input with its original basename and captured bytes.

Source paths are retained as declarative provenance where useful for audit, but
agents never receive them as document references. Environment variables and
other executor environment values are not part of this model.

Configuration, workflow, instruction, and prompt files must resolve within the
canonical project root. Explicit inputs are resolved relative to the caller's
current directory and may be anywhere. Every input must resolve to a readable,
regular file whose extension is `.md`, compared case-insensitively. All this
validation and reading happens before the run ID is allocated.

## Durable Layout

Each run stores an immutable snapshot equivalent to:

```text
.happy-machine/runs/<run-id>/
├── snapshot/
│   ├── manifest.json
│   ├── definition/
│   │   ├── happy-machine.yaml
│   │   ├── workflow.yaml
│   │   ├── effective.json
│   │   ├── agents/<agent-id>/instructions.md
│   │   └── prompts/<prompt-id>/prompt.md
│   └── inputs/<input-id>/<original-name>.md
├── states/<state-id>/visits/<visit-number>/context.md
└── run.json
```

Input IDs are deterministic within a run and assigned by CLI argument order as
`input-0001`, `input-0002`, and so on. Consequently, repeated basenames never
collide and every argument has one index entry. Prompt IDs are derived from
state and task identities, not source basenames.

The repository writes the whole snapshot into a sibling staging directory,
using exclusive file creation, then atomically renames it into place. A failure
before the rename leaves no committed snapshot or run record. Once committed,
snapshot and context files are never rewritten by Happy Machine.

## Manifest and Identity

`manifest.json` records the snapshot format version, workflow identity, every
artifact's stable internal path, its role, and its SHA-256 content hash. It also
contains the complete effective definition in a deterministic JSON
representation. Artifact entries are emitted in a defined order and object keys
are canonicalized recursively.

The definition snapshot identity is `sha256:<hex>`, calculated from the
canonical manifest payload before its identity field is added. The payload
therefore commits to all raw declarative artifacts, their hashes and roles, all
effective values, and every input. Anyone with the run directory can recompute
the identity without the original files.

The identity is stored on the run record and included in the `run_created`
event. Environment data, secrets, timestamps, run IDs, original absolute input
paths, and mutable control paths are excluded from the identity payload. Two
executions with identical declarative definitions and ordered input contents
therefore have the same snapshot identity.

## Context and Launch Behavior

`context.md` belongs to the state visit rather than an attempt. For the initial
visit it contains run and visit identifiers followed by an input index. Each
entry includes the stable input ID, original basename, immutable internal path,
content hash, and durable absolute path under the run snapshot. It never links
to an original input path and performs no semantic selection or summarization.

Attempt-specific output directories and `result.json` paths remain under each
attempt directory. The task launch contract separately supplies those paths,
the immutable visit context path, and snapshotted instructions, prompt, model,
and policies. Creating a later attempt for the same visit reuses the exact
context path and bytes while allocating new output and result locations.

The snapshot, visit context, output directory, and result destination parent
exist before the executor is invoked. Orca receives captured strings and
snapshot paths and never rereads the original configuration, instruction,
prompt, or input files.

## CLI Behavior and Errors

The accepted syntax is:

```text
happy-machine execute <workflow.yaml> [--input <document.md> ...]
```

`--input` may appear zero or more times after the workflow path. A missing value,
unknown option, or extra positional argument is a CLI error with exit code 1.
Definition and input validation errors are reported through the existing error
path and do not print a run ID or invoke Orca.

## Testing

Focused tests will prove:

- Zero, internal, external, duplicate-basename, repeated, missing, unreadable,
  nonregular, and non-Markdown inputs.
- Project-relative configuration paths cannot escape through `..` or symlinks.
- Inputs are copied before launch and remain readable after originals are edited
  or removed.
- Inline prompts, prompt files, all agent instructions, effective policies, and
  model overrides appear in the snapshot.
- Existing snapshots do not change after any source definition is edited, while
  a later execution receives a different identity and content.
- Manifest hashes and the snapshot identity can be independently recomputed.
- Duplicate basenames receive distinct IDs and appear exactly once in
  `context.md` with durable snapshot paths.
- Multiple attempts in one visit receive the same immutable context path and
  bytes.
- A sentinel environment secret does not appear in the run record, events,
  manifest, snapshot files, context, or executor contract.
- An observed Orca launch occurs only after the complete snapshot and all
  required control paths exist.
- End-to-end execution reads the copied input content after the original is
  changed or removed.

The full lint, test, and typecheck suites must pass after implementation.
