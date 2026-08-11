# Task 13: Execute workflows with Git worktree isolation

## Objective

Provide workspace.mode worktree to isolate the run from the original directory and give each parallel task an independent Git workspace without automating commits or merges.

## Functional value

Agents can modify code during sequential and parallel paths within clear physical boundaries. The product retains enough metadata for a later state or user to integrate changes deliberately.

## Dependencies

- Task 12.

## Scope

- Prepare one managed main worktree when starting a run configured with workspace.mode worktree.
- Create the main worktree from the original project's current HEAD at preparation time.
- Do not copy, validate, or reject uncommitted changes from the original directory.
- Use the main worktree for every sequential state in the run.
- Create a separate child worktree for every task in a parallel state.
- Create each child from the main worktree's current HEAD when the parallel state begins.
- Do not propagate, copy, validate, or reject uncommitted changes present in the main worktree before fan-out.
- Allow the workflow author to instruct an earlier agent to create commits when children must inherit changes, without Happy Machine creating those commits.
- Keep per-attempt control workspaces isolated in addition to project-workspace isolation.
- Record each worktree's managed path, branch, starting HEAD, ending HEAD, and dirty status.
- Add the metadata needed by a later state to inspect or integrate changes to context.md.
- Allow an integration agent to operate according to its instructions using recorded paths and branches.
- Do not automatically create commits, merges, patches, reverts, or rollback.
- Do not delete branches or commits when a worktree is eventually removed.
- Retain every worktree after succeeded, failed, or canceled until a cleanup decision.
- If creation of a required workspace fails after run creation, end the run as failed with a durable cause.

## Out of scope

- Propagating uncommitted changes to the main or child worktrees.
- Blocking fan-out because the main worktree is dirty.
- Automatically merging child worktrees.
- Resolving Git conflicts.
- Deleting user branches, commits, or changes.
- Deciding which child contains the correct version.
- Running cleanup; that belongs to Task 14.

## Acceptance criteria

1. **Main from HEAD:** Given an original project with uncommitted changes, when the run worktree is created, then it starts from current HEAD and neither contains nor rejects those local changes.
2. **Shared sequential workspace:** Given two consecutive normal states, when the first modifies the main worktree, then the second uses that same workspace and can observe the modification.
3. **Independent fan-out:** Given a parallel state with three tasks, when it starts, then each task receives a different child worktree and paths do not collide.
4. **Child base:** Given a new commit in the main worktree before fan-out, when children are created, then all start from that HEAD.
5. **Uncommitted-change limitation:** Given a dirty main worktree before fan-out, when children are created, then none receives those changes and Happy Machine neither blocks nor repairs the situation.
6. **No automatic merge:** Given that two children create commits or incompatible changes, when the join finishes, then the main worktree is unchanged and Happy Machine created no merge, cherry-pick, or patch.
7. **Complete metadata:** Given a run with main and child worktrees, when status or later context.md is inspected, then the path, branch, starting HEAD, ending HEAD, and dirty status of each can be identified.
8. **Explicit integration:** Given a later state instructed to integrate, when it starts, then it receives stable worktree references and any observed integration comes from the agent, not the engine.
9. **Terminal retention:** Given that the run ends as succeeded, failed, or canceled, when worktrees are inspected, then all remain present until cleanup.
10. **Branches preserved:** Given that a worktree is later removed, when the repository is inspected, then Happy Machine did not delete its branches or commits.
11. **Preparation failure:** Given that Git cannot create the main worktree after run ID allocation, when execute prepares the workspace, then the run ends as failed, retains the cause, and does not launch the initial state.

## Required tests

- Integration tests on temporary Git repositories with clean and dirty original directories.
- Sequential test observing changes in the same main worktree.
- Parallel test with different commits and uncommitted changes in each child.
- Normative fan-out test from a dirty main worktree.
- Test proving the absence of automatic commits and merges.
- Metadata tests through context.md, status, and history.

## Traceability

- PRODUCT.md: Invariant 5.11; Sections 4.8, 6.2, 7.3, 9, 10.3, 11, 13, 15, 18, 19.1, 21.5, 22.3, and 24.
- Normative scenarios: 25.15 and 25.16.

## Definition of done

- Sequential and parallel paths work on real temporary Git repositories.
- The dirty-main test explicitly demonstrates the v1 fan-out limitation.
- Every automatic Git action is limited to creating and observing worktrees; the engine creates no commits or merges.
- Metadata supports later integration without relying on inferred paths.
