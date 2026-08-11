# Task 14: Retain and clean up worktrees without losing user changes

## Objective

Provide explicit, conservative cleanup of managed worktrees after run completion while refusing to remove any workspace with uncommitted changes.

## Functional value

Users can reclaim space without risking agent work or losing evidence. Retention is always the default, and cleanup can be attempted again later.

## Dependencies

- Task 13.

## Scope

- Expose happy-machine cleanup RUN_ID.
- Retain worktrees after any succeeded, failed, or canceled completion.
- When an attached interactive execute, resume, or cancel observes the complete run enter a terminal status, ask exactly once whether managed worktrees should be cleaned up.
- Do not ask after individual states, tasks, attempts, or joins.
- Use retention as the default answer.
- Retain without prompting when no interactive TTY exists, no controller is attached, or the user does not answer.
- Durably record that the terminal prompt was shown and the selected decision so it is not repeated.
- Apply the same safe evaluation through cleanup that is available from the terminal prompt.
- Resolve the exact managed worktrees owned by the run before acting.
- Remove only clean worktrees.
- Refuse to remove a dirty worktree and report its path and condition for manual attention.
- Process every worktree independently so one dirty worktree does not hide the results for others.
- Preserve the durable database, snapshots, history, documents, logs, branches, and commits.
- Do not delete source changes, branches, or commits as part of cleanup.
- In direct mode, report success and state that no managed worktrees exist.
- Record every evaluated worktree, decision, and removal result.

## Out of scope

- Forcibly removing a dirty worktree.
- Automatically committing, stashing, resetting, or backing up work to permit cleanup.
- Deleting branches, commits, logs, documents, or durable history.
- Cleaning worktrees before the complete run is terminal.
- Automatic cleanup by age or background process.

## Acceptance criteria

1. **Single prompt:** Given a run with worktrees that reaches a terminal status in an attached interactive CLI, when completion is observed, then the user is asked exactly once for that run and never during intermediate steps.
2. **Retention by default:** Given that the user presses Enter or does not answer, when the prompt finishes, then every worktree is retained.
3. **No noninteractive prompt:** Given execute, resume, or cancel without a TTY, when the run finishes, then no input is awaited and worktrees are retained.
4. **Clean-worktree cleanup:** Given a terminal run with a clean worktree, when the user confirms cleanup or invokes cleanup, then the worktree is removed while its branch, commits, and historical metadata remain.
5. **Dirty-worktree protection:** Given a worktree with uncommitted changes, when cleanup is requested, then it is not removed and the path requiring attention is reported clearly.
6. **Mixed result:** Given two clean worktrees and one dirty worktree, when cleanup runs, then the two clean worktrees are removed, the dirty one is retained, and all three results are reported.
7. **History remains intact:** Given that cleanup removed worktrees, when status and history are queried, then snapshots, documents, logs, decisions, and historical metadata remain available.
8. **Direct mode:** Given a terminal direct-mode run, when cleanup is invoked, then it succeeds and reports that no managed worktrees exist.
9. **Nonterminal run:** Given a running, detached, or canceling run, when cleanup is invoked, then no worktree is removed and a clear operational error is returned.
10. **Prompt is not repeated:** Given that the terminal run already displayed the prompt, when another attached command observes the same status, then it does not ask again; explicit cleanup remains available.

## Required tests

- Pseudo-TTY tests for acceptance, default response, no response, and single prompting.
- Noninteractive tests for execute, resume, and cancel.
- Git tests with clean, dirty, and mixed worktrees.
- Test preserving branches, commits, and the complete durable store.
- Test of cleanup in direct mode and for a nonterminal run.

## Traceability

- PRODUCT.md: Invariant 5.11; Sections 6.2, 18.2–18.3, 21.5, 22.1, 22.5, and 24.
- Normative scenarios: 25.18 and 25.19.

## Definition of done

- No cleanup path can remove a dirty worktree.
- The prompt appears exactly once and never blocks noninteractive execution.
- Cleanup does not delete history, documents, logs, branches, or commits.
- The explicit command can retry cleanup for worktrees that remain retained.
