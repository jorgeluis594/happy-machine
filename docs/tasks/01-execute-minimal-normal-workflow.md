# Task 01: Execute a minimal normal workflow end to end

## Objective

Allow a user to execute a valid Happy Machine project from the CLI with a single normal state and observe the run terminate at the declared terminal target.

## Functional value

This task delivers the product's first useful path: discover a project, prepare a durable run, assign work to an agent through Orca, interpret its result, and finish with an observable status. It is not merely scaffolding; once complete, a minimal workflow works end to end.

## Dependencies

None.

## Scope

- Expose the command happy-machine execute WORKFLOW_PATH.
- Discover the project by searching upward for the nearest happy-machine.yaml, starting from the workflow path or current directory.
- Resolve the directory containing happy-machine.yaml as the project root.
- Support schema version 1, one local agent with a Markdown instruction file and default model, and a workflow containing one agent state.
- Support either an inline prompt or prompt_file, combining it with the agent instructions and the generated context contract.
- Use Orca when executor.type is omitted or set to orca.
- Use workspace.mode direct when the mode is omitted or set to direct.
- Resolve the default values needed for the initial attempt.
- Create project-local storage under .happy-machine, allocate and print a run ID, and persist the run before starting external work.
- Create a visit, the normal state's implicit task, an isolated control workspace, and a stable attempt identity.
- Communicate the project workspace, context.md, output directory, result.json, instructions, prompt, model, timeout, and attempt number to Orca unambiguously.
- Consume machine-readable Orca lifecycle responses and retain their basic identifiers and logs.
- Accept a valid result.json containing a configured outcome and an empty documents array.
- Ignore stdout and stderr when selecting the outcome.
- Resolve the outcome to $succeeded or $failed, persist the terminal status, and end the command with the corresponding exit code.

## Out of scope

- Exhaustive validation of every invalid configuration form.
- Workflows with more than one state, cycles, or parallel states.
- External inputs or documents produced by agents.
- Retries, cancellation, detach, resume, status, history, and cleanup.
- Project workspaces managed through Git worktrees.

## Acceptance criteria

1. **Successful execution:** Given a valid project and a state whose agent returns the outcome mapped to $succeeded, when the workflow is executed, then a run ID is printed before the agent starts, Orca receives the task, and the run ends as succeeded with exit code 0.
2. **Explicit unsuccessful termination:** Given an outcome mapped to $failed, when the agent returns it validly, then the run ends as failed and the command returns exit code 1.
3. **Upward discovery:** Given that the command starts in a project subdirectory, when an ancestor contains happy-machine.yaml, then the nearest file is used and all internal paths resolve from that root.
4. **Missing project:** Given a directory with no happy-machine.yaml in its ancestor chain, when execution is attempted, then the command fails with exit code 1 before creating a run or invoking Orca.
5. **Default values:** Given that executor.type and workspace.mode are omitted, when the workflow executes, then Orca and direct mode are used.
6. **Launch contract:** Given a valid run, when the attempt begins, then Orca receives every path and parameter listed in scope unambiguously, and the persisted identity includes the run, state, visit, task, and attempt.
7. **Structured result controls routing:** Given stdout text that resembles one outcome while result.json contains another valid outcome, when the attempt finishes, then the engine selects only the result.json value.
8. **Minimal durable state:** Given that the command finishes, when the project store is inspected, then it contains the run, visit, attempt, Orca references, outcome, terminal target, and logs attributable to that attempt.

## Required tests

- Integration tests for discovery from the project root and nested directories.
- End-to-end test with a controlled Orca fixture for $succeeded.
- End-to-end test with a controlled Orca fixture for $failed.
- Test proving stdout and stderr do not control routing.
- Test verifying creation and consistency of the minimal durable state.

## Traceability

- PRODUCT.md: Sections 2, 4.1–4.8, 5, 6, 7.1–7.3, 8.1–8.4, 11, 12.1, 14, 20, 21.1, 22.1–22.2, and 22.5.
- Related normative scenario: 25.1, limited in this task to a terminal target.

## Definition of done

- All acceptance criteria are automated and pass repeatedly.
- The minimal workflow can be executed from a clean package installation.
- The run and its attempt are durably recorded and causally attributable.
- No functionality declared out of scope is required to demonstrate the path.
