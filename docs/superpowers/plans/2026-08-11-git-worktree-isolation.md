# Git Worktree Isolation Implementation Plan

## Goal

Implement `docs/tasks/13-git-worktree-isolation.md` according to the approved
design in
`docs/superpowers/specs/2026-08-11-git-worktree-isolation-design.md`.
Worktree-mode runs must isolate sequential and parallel project changes in real,
retained Git worktrees while recording enough durable metadata for status,
history, recovery, cancellation, and an explicitly instructed later integration
agent. Happy Machine must never create commits or integrate source changes.

## Requirement-to-evidence checklist

| Requirement | Authoritative evidence |
| --- | --- |
| Main starts from original HEAD and ignores dirty original files | Real-Git integration test comparing the original HEAD/tree and main worktree contents |
| Sequential states share one main workspace | Two-state executor test that writes in the first launch and reads the same file/path in the second |
| Every parallel task gets a distinct child | Three-task real-Git test comparing launch paths and durable task metadata |
| Every child starts at one captured main HEAD | Test commits in the main worktree before fan-out and compares all child starting HEADs/content |
| Dirty main changes neither propagate nor block | Normative real-Git test with modified and untracked main files before fan-out |
| No automatic commit or integration | Test records main HEAD/status before fan-out and after join while children contain commits and incompatible edits |
| Complete main and child metadata | Assertions over durable `run.json`, later `context.md`, CLI status, and causal history |
| Later agent gets stable integration references | Downstream normal-state launch reads context containing exact retained paths and branches |
| Worktrees survive every terminal result | Succeeded, failed, and canceled integration tests assert all registered paths still exist |
| Branches and commits survive worktree removal | Real-Git test removes a clean worktree with Git and verifies branch/commit reachability |
| Preparation failure is durable and launches no state | Injected workspace-port failure after run allocation, followed by repository reload and executor-call assertion |
| Attempt control workspaces remain isolated | Worktree-mode retry/parallel assertions compare control paths independently of project paths |

## 1. Add the durable workspace model and resolution rules

Files:

- `src/domain/execution/run.ts`
- focused additions to existing domain tests or `tests/git-worktree-isolation.test.ts`

Changes:

- Add `ManagedWorktreeRecord` with a stable ID, main/child role, optional child
  provenance, path, branch, starting HEAD, ending HEAD, and dirty status.
- Add a run-level workspace record containing `mode` and the ordered managed
  worktree registry. Keep deserialization compatible with existing direct-mode
  run fixtures and runs written before this task by treating an absent registry
  as direct mode.
- Expand parallel-task workspace metadata to include branch, starting HEAD, and
  ending HEAD rather than the current ambiguous single `head` field.
- Add a parallel-visit fan-out HEAD field. Persist it before creating any child
  so recovery always uses the original captured base even if the main branch
  advances later.
- Add pure helpers that find the main worktree, locate a child by state/visit/task,
  resolve a task's project workspace, and update observed metadata without
  changing identity/base fields.
- Test uniqueness/provenance lookup and direct-mode fallback without filesystem
  dependencies.

Focused check:

```sh
npx vitest run tests/git-worktree-isolation.test.ts
npm run typecheck
```

## 2. Define and implement the project-workspace capability

Files:

- `src/ports/project-workspaces.ts`
- `src/infrastructure/outbound/project-workspaces/git/git-project-workspaces.ts`
- `tests/git-project-workspaces.test.ts`

Port contract:

- `ensureMain` receives the original project root and run ID, resolves the
  original repository's current HEAD, and returns the complete main record.
- `ensureChild` receives original root, run/state/visit/task identity, and one
  exact starting HEAD captured from the main worktree.
- `observe` receives a durable managed record and returns its current ending
  HEAD and dirty status.
- `ProjectWorkspaceError` exposes the stable
  `workspace_preparation_failed` code and a safe operation diagnostic.

Git adapter behavior:

- Use `execFile`/argument arrays for every Git call.
- Generate deterministic paths under
  `.happy-machine/worktrees/<run-id>/...` and deterministic Git-safe branches
  under `happy-machine/<run-id>/...`.
- Resolve and validate full commit IDs with `rev-parse`.
- Create worktrees with `git worktree add -b <branch> <path> <commit>` only.
- On retry, inspect Git's worktree registry plus the path's repository, branch,
  and HEAD. Adopt only an exact deterministic match.
- Refuse path, branch, or registration conflicts. Never force, reset, prune,
  remove, delete a branch, or mutate project files.
- Observe HEAD with `rev-parse HEAD` and dirty state with porcelain status that
  includes untracked files.

Real-Git adapter tests:

- main creation from clean and dirty originals;
- child creation at an exact commit while the main is dirty;
- three collision-free children;
- idempotent ensure after simulated save loss;
- conflicting branch/path refusal;
- dirty and committed ending observations;
- manual worktree removal retaining branch and commit.

Focused check:

```sh
npx vitest run tests/git-project-workspaces.test.ts
npm run typecheck
```

## 3. Prepare and dispatch workspaces in execution

Files:

- `src/application/use-cases/execute-workflow.ts`
- `src/composition-root.ts`
- `tests/git-worktree-isolation.test.ts`
- targeted updates to executor/use-case test doubles

Changes:

- Inject `ProjectWorkspaces` into `ExecuteWorkflow` from the composition root.
- Initialize the run-level mode immediately after snapshot creation. Preserve
  the existing guarantee that definition loading finishes before ID allocation
  or any workspace side effect.
- Persist and announce the allocated run before calling `ensureMain`, matching
  the requirement that Git creation can fail after allocation.
- For worktree mode, ensure/persist/event the main record before entering the
  initial state. Map a failure to a durable failed run with no visit and no
  executor launch; return that run instead of losing the cause behind an
  uncaught process failure.
- Use the main path for every normal task attempt and retry.
- Before creating a parallel visit context or starting a worker, observe the
  main once, capture its ending HEAD, ensure every child from that exact commit,
  attach the child metadata to its task, and durably save each registration.
  Do not test dirty state as a scheduling precondition.
- Reuse each child's path for its retries.
- Observe the assigned worktree after every settled task, updating both the
  run registry and parallel task mirror. Observe all worktrees once more before
  any succeeded/failed terminal save.
- Append creation/observation/failure events with complete provenance.

Real-Git integration tests implement acceptance criteria 1–9 and 11, including
the sequential, fan-out, dirty-main, no-merge, retained-terminal, metadata, and
preparation-failure scenarios listed in the checklist.

Focused check:

```sh
npx vitest run tests/git-worktree-isolation.test.ts tests/execute-workflow.test.ts tests/parallel-states.test.ts
npm run typecheck
```

## 4. Make context and presentation expose the durable registry

Files:

- `src/infrastructure/outbound/run-repository/filesystem/filesystem-run-repository.ts`
- `src/infrastructure/inbound/cli/run-presenter.ts`
- `tests/git-worktree-isolation.test.ts`
- `tests/status-history-observability.test.ts`
- relevant snapshot/context assertions

Changes:

- Render an explicit `Managed project worktrees` section in every newly created
  visit `context.md`. Include mode, stable ID, role/provenance, path, branch,
  starting HEAD, ending HEAD, and dirty status. In direct mode, identify the
  original project root without fabricating a managed worktree.
- Ensure parallel child records are persisted before the parallel visit context
  is rendered so the tasks receive their own and sibling references.
- Add a status section that lists the complete run-level registry, not only the
  current parallel visit. Update parallel task lines to show unambiguous start
  and end HEADs.
- Rely on stored events for history; verify creation and observation event JSON
  includes every required metadata field.
- Preserve context immutability: later observations appear in later visit
  contexts and status/history, not by rewriting an earlier context file.

Focused check:

```sh
npx vitest run tests/git-worktree-isolation.test.ts tests/status-history-observability.test.ts tests/run-snapshot.test.ts
npm run typecheck
```

## 5. Preserve isolation through recovery and cancellation

Files:

- `src/application/use-cases/recover-workflow.ts`
- `src/application/use-cases/cancel-workflow.ts`
- `src/composition-root.ts`
- `tests/durable-recovery.test.ts`
- `tests/durable-cancellation.test.ts`
- `tests/git-worktree-isolation.test.ts`

Recovery changes:

- Inject the workspace port.
- Ensure/re-adopt the durable main before creating or dispatching a missing
  visit in worktree mode.
- Finish missing child preparation for a parallel visit from its already
  captured base. Persist captured fan-out base data before child creation so a
  crash cannot silently choose a newer main HEAD.
- Resolve executor recovery, relaunch, timeout cancellation, and reconciliation
  against the task's recorded project workspace.
- Observe assigned worktrees as recovered tasks settle and before terminal
  persistence.

Cancellation changes:

- Resolve every active attempt's task workspace rather than using
  `run.projectRoot` for executor recovery/cancel/reconciliation.
- Observe retained worktrees after execution reconciliation and before the
  canceled terminal save. Record an observation failure without deleting or
  modifying the workspace and retain the cancellation evidence.

Tests:

- recovery after main/child Git creation but before metadata save;
- recovery after captured fan-out base persistence;
- recovered relaunch and executor observation using main/child paths;
- cancellation using the active child path;
- retained worktrees and final metadata after canceled completion.

Focused check:

```sh
npx vitest run tests/durable-recovery.test.ts tests/durable-cancellation.test.ts tests/git-worktree-isolation.test.ts
npm run typecheck
```

## 6. Validate coherent commits

After the adapter/model slice and again after the orchestration slice is
coherent:

```sh
npm run lint:fix
npm test
npm run typecheck
git diff --check
```

Inspect the entire diff, stage only Task 13 files, and create concise semantic
commits. Leave the existing untracked `.happy-memory/` and `.superpowers/`
directories untouched.

## 7. Completion audit

- Re-read `docs/tasks/13-git-worktree-isolation.md` and the approved design.
- Map all 11 acceptance criteria, every scope item, every required test, and
  every definition-of-done statement to a current test assertion or direct
  source inspection.
- Inspect the workspace port and Git adapter to prove their public and private
  operations cannot commit, merge, patch, reset, clean, remove, or delete.
- Inspect real repositories produced by tests where needed to distinguish
  retained paths, branch reachability, HEAD identity, dirty state, and tree
  contents from indirect mocks.
- Run final verification from the committed tree:

```sh
npm test
npm run typecheck
```

- Consolidate durable workspace conventions and behavioral constraints into
  repository memory only after implementation and tests prove them.
