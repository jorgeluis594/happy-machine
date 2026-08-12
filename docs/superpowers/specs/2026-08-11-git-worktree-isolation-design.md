# Git Worktree Isolation Design

## Purpose

Implement Task 13 so a workflow configured with `workspace.mode: worktree`
runs in retained Git worktrees instead of the original project directory. A run
uses one main worktree for sequential states and one child worktree per parallel
task. Happy Machine creates and observes these worktrees but never commits,
merges, copies changes, repairs dirty state, rolls changes back, or cleans them
up.

Direct-mode behavior remains unchanged.

## Architecture

### Domain records

The run record owns a durable project-workspace registry. It records the
configured mode and every managed worktree. Each managed worktree contains:

- its role: the run main worktree or a parallel-task child;
- the parallel state, visit, and task identity for a child;
- its managed path and branch;
- its starting HEAD;
- its most recently observed ending HEAD and dirty status.

Parallel task records continue to expose the concrete workspace assigned to
that task. The run-level registry is authoritative for retained-worktree
lifecycle and complete status, while task-level data makes dispatch and
inspection direct. A domain helper resolves the correct project workspace for
any task: the original project in direct mode, the main worktree for a normal
state, or the task's child worktree for a parallel state.

### Project workspace port

A new port describes the external workspace capability required by the
application. It supports three operations:

1. Ensure the run's main worktree exists at the original repository's selected
   HEAD.
2. Ensure a parallel child exists at an exact captured main-worktree commit.
3. Observe a managed worktree's current HEAD and dirty status.

“Ensure” is intentional. Paths and branches are deterministic, so repeating an
operation after a controller crash returns the already registered matching
worktree instead of creating a second workspace. A conflicting path, branch,
or registration fails safely; the adapter never overwrites or removes it.

The application layer coordinates when these operations happen. The port owns
technology-independent requests, results, and workspace errors. Git and
filesystem operations remain in an outbound Git adapter. The composition root
wires the adapter into execution, recovery, and cancellation.

### Git adapter conventions

Managed worktrees live under:

```text
<project>/.happy-machine/worktrees/<run-id>/
├── main/
└── states/<state-id>/visits/<visit-number>/tasks/<task-id>/
```

Managed branches live under `happy-machine/<run-id>/` with deterministic main
and child suffixes. Definition validation already restricts workflow
identifiers; the adapter additionally produces Git-safe branch components.

The adapter invokes Git with argument arrays, captures diagnostics, and maps
failures to the workspace port's errors. It creates branches and worktrees only.
It exposes no commit, merge, cherry-pick, patch, reset, stash, removal, or branch
deletion operation.

If a crash occurs after Git creates a branch or worktree but before the run is
saved, a repeated ensure operation verifies and adopts that exact deterministic
resource. Existing unrelated filesystem content or an incompatible Git
registration is never adopted.

## Execution Flow

### Run preparation

Execution preserves the definition-validation side-effect barrier. It fully
loads and validates the effective definition before generating a run ID,
allocating durable run state, creating control workspaces, or invoking Git.

After validation, execution creates the definition snapshot and run record,
persists the run, and reports the allocated run ID. For worktree mode it then
ensures the main worktree from the original project's current HEAD. Local
uncommitted changes in the original directory are neither read for propagation,
validated, rejected, nor copied. The resulting metadata is added to the run and
persisted before the initial state is created or launched.

If main-worktree preparation fails, execution records a
`workspace_preparation_failed` terminal cause and a terminal event on the
already allocated run. The initial state and executor are never launched. Any
worktree or branch that Git created before reporting failure is retained.

### Sequential states

Every normal state and all of its retry attempts receive the same retained main
worktree path. Filesystem changes therefore remain visible to later sequential
states. Happy Machine observes and persists the main worktree after each task
settles, whether the task succeeds or fails, without interpreting or modifying
the changes.

### Parallel fan-out

When a parallel state begins, the application reads the main worktree's current
HEAD exactly once. It does not inspect dirty state as a precondition. It then
ensures one child worktree for every task from that captured commit and persists
each child before scheduling any task.

This ordering gives every child the same committed base and prevents path
collisions. Dirty or untracked files in the main worktree remain only in the
main worktree. A commit created by an earlier agent is inherited because it is
part of the captured HEAD; an uncommitted edit is not. Each task and all of its
retries reuse that task's child worktree.

Parallel execution remains all-settled. When each task settles, Happy Machine
observes that child's ending HEAD and dirty state. The join only commits workflow
documents and transition state. It performs no source-control integration, so
the main worktree remains unchanged unless an agent explicitly changes it in a
later state.

### Later integration states

Visit context is created only after required worktrees for that visit are
durably registered. Every `context.md` lists the complete managed-worktree
registry known at that point, including stable paths, branches, starting and
ending HEADs, dirty status, roles, and child provenance. A later agent can use
these references according to its instructions. Any commits or merges it
performs are ordinary agent actions in its assigned main worktree, not engine
actions.

## Recovery and Cancellation

Recovery uses the durable registry and deterministic ensure operations. It
finishes an interrupted main or child preparation when necessary, reuses
already created worktrees, and dispatches or reconciles every attempt using its
recorded project workspace rather than the original project root.

Cancellation likewise passes the active task's actual project workspace to the
executor. Once active executions are reconciled, it observes all retained
worktrees before persisting the canceled terminal state. Successful and failed
terminal paths perform the same final observation. Observation updates metadata
only; terminal handling never removes a worktree or branch.

An observation failure is recorded as an engine/workspace failure when the run
is still executing. During cancellation, the cancellation evidence remains
durable even if observation cannot complete; the worktree remains retained and
the failure is visible in history.

## Durable Context, Status, and History

The filesystem run repository renders managed-worktree metadata into each
immutable visit context alongside the existing snapshot and document index.
Status gains a dedicated worktree section so the main worktree and every child
can be identified even when they do not belong to the current visit. Parallel
task lines continue to show their assigned workspace.

Creation and observation append causal events containing the worktree role,
provenance, path, branch, starting HEAD, ending HEAD, and dirty status. The
existing history renderer exposes those durable events without reading live Git
state. Status and history remain read-only.

## Retention and Source-Control Boundaries

All managed worktrees remain registered and present after succeeded, failed, or
canceled completion. Task 13 adds no cleanup path. The Git adapter has no API
that can remove a worktree or delete a branch. If a worktree is later removed by
Task 14 or manually with Git, its branch and commits remain because removal and
branch deletion are separate operations.

Happy Machine never automatically:

- commits or stages project files;
- merges, rebases, cherry-picks, or applies patches;
- copies original or main-worktree uncommitted changes;
- rejects or repairs a dirty project workspace;
- resets or rolls back source files;
- removes worktrees, branches, or commits.

## Error Handling

Workspace errors carry a stable code and a diagnostic that includes the failed
operation without exposing unrelated environment data. Required workspace
creation happens before the corresponding state launches. A failed main or
child creation therefore leaves the run durably failed and launches no task
whose workspace was not prepared.

Partially created worktrees and branches are retained. Completed metadata writes
are never discarded merely because a later child fails. Retry and recovery use
the same workspace for an existing task rather than allocating new worktrees.

## Testing Strategy

Integration tests create real temporary Git repositories with configured user
identity and initial commits. They cover:

- clean and dirty original directories, proving the main starts from HEAD and
  ignores local changes;
- two sequential states observing edits through the same main path;
- three parallel tasks receiving different child paths;
- a committed main-worktree change inherited by every child;
- a dirty main worktree whose uncommitted changes neither propagate nor block
  fan-out;
- child-specific commits and uncommitted edits, proving isolation and complete
  ending metadata;
- an unchanged main HEAD and tree after parallel join, proving the absence of
  automatic commits or integration;
- later-state `context.md`, status, and history containing complete stable
  worktree metadata;
- retained worktrees after succeeded, failed, and canceled runs;
- manual Git worktree removal leaving managed branches and commits intact;
- a forced main-worktree preparation failure after allocation, proving the
  durable cause and absence of an initial launch;
- crash/recovery reuse of deterministic worktrees and the recorded workspace
  during executor recovery and cancellation;
- continued per-attempt control-workspace isolation in worktree mode.

Focused adapter tests verify Git command failure mapping, idempotent ensure
behavior, conflict refusal, exact-base child creation, observation, and the
absence of destructive adapter operations. Existing direct-mode, recovery,
cancellation, status/history, retry, timeout, and parallel suites remain green.

## Acceptance Mapping

The main preparation flow covers acceptance criteria 1 and 11. Shared main
dispatch covers criterion 2. Captured-HEAD child creation covers criteria 3–5.
The absence of integration operations and unchanged-main assertions cover
criterion 6. Durable records, contexts, events, and presentation cover criteria
7 and 8. Terminal observation without cleanup covers criterion 9. The adapter's
restricted API and manual-removal test cover criterion 10.
