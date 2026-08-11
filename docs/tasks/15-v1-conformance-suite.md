# Task 15: Certify the v1 contract with a comprehensive conformance suite

## Objective

Automatically demonstrate that a clean Happy Machine installation jointly satisfies every normative behavior, command, invariant, and acceptance scenario in PRODUCT.md.

## Functional value

Earlier tasks prove individual capabilities; this task proves they operate together as one coherent product. The suite provides executable evidence for deciding whether v1 is truly complete and prevents future changes from breaking durability or no-duplication guarantees.

## Dependencies

- Tasks 01 through 14.

## Scope

- Create self-contained fixtures for projects, agents, prompts, workflows, and Markdown inputs.
- Exercise the installed CLI through its six public commands: execute, status, history, resume, cancel, and cleanup.
- Use a controllable Orca environment that honors the machine-readable contract and can simulate completion, failure, question, escalation, timeout, cancellation, uncertainty, and provenance lookup.
- Cover the twenty normative scenarios in PRODUCT.md Section 25 as individually identifiable acceptance tests.
- Cover all ten v1 success criteria in Section 26 through a test traceability matrix.
- Verify every global invariant in Section 5, including atomicity, immutability, a single controller, and no duplication of uncertain execution.
- Verify policy defaults, precedence, and scopes with at least one workflow combining all four permitted levels.
- Verify the observable taxonomy of definition error, attempt failure, parallel aggregate failed, run failure, command conflict, and cancellation.
- Verify that status and history are sufficient to explain every suite path.
- Verify exit codes 0, 1, 2, and 130 through real processes.
- Run scenarios in direct and worktree modes as appropriate.
- Include fault injection at critical launch and completion atomicity boundaries.
- Run from a built package installed in a clean temporary directory rather than through internal test imports.
- Produce a report mapping every normative requirement to one or more tests and flagging any uncovered requirement.
- Fail the suite when tests are omitted, scenarios are skipped, or normative requirements lack traceability.
- Explicitly confirm that capabilities excluded from v1 are not required accidentally.

## Out of scope

- Adding new product behavior to make the suite pass without returning to the corresponding functional task.
- Measuring performance, load, or scalability not defined by PRODUCT.md.
- Testing executors other than Orca.
- Requiring a UI, global registry, human approval states, webhooks, daemon, parallel subflows, semantic merge, automatic commits or merges, rollback, executable configuration, or on_failure.
- Depending on uncontrolled external services for ordinary suite execution.

## Acceptance criteria

1. **Normal routing:** An automated test for 25.1 proves needs_revision commits documents and enters exactly the configured state.
2. **Unknown outcome:** A test for 25.2 proves attempt validation failure, stable retry context, and terminal failure after attempts are exhausted.
3. **Bounded cycle:** A test for 25.3 proves a new visit with prior draft and feedback in context.
4. **Fresh retry:** A test for 25.4 proves a clean control workspace and no promotion of partial outputs.
5. **Failed source changes:** A test for 25.5 proves workspace persistence and exclusion from context.md and routing.
6. **Parallel succeeded:** A test for 25.6 proves an all-settled join and aggregate succeeded.
7. **Parallel failed:** A test for 25.7 proves the absence of fail-fast behavior and calculation of the aggregate only after settlement.
8. **Parallel failure recovery:** A test for 25.8 proves inspect_failures receives successful documents and complete error summaries.
9. **Detach and resume:** A process test for 25.9 proves exit code 130, absence of cancellation, and no duplication.
10. **Concurrent controller:** A test for 25.10 proves run_already_controlled without mutation.
11. **Attempt timeout:** A test for 25.11 prevents retry until the previous execution is confirmed stopped.
12. **Question or escalation:** A test for 25.12 keeps the attempt and its deadline active.
13. **Definition snapshot:** A test for 25.13 distinguishes resume from a new execute after definition edits.
14. **External input snapshot:** A test for 25.14 modifies the original while preserving the run copy.
15. **Fan-out limitation:** A Git test for 25.15 leaves the main worktree dirty and proves children start from HEAD.
16. **No automatic merge:** A test for 25.16 proves the join creates neither commit nor merge.
17. **Cancellation:** A test for 25.17 preserves evidence, reaches canceled, and rejects resume.
18. **Cleanup prompt:** A pseudo-TTY test for 25.18 asks once, only at run termination, and retains by default.
19. **Dirty cleanup:** A test for 25.19 protects changes, branches, commits, and history.
20. **Detached deadline:** A controlled-clock test for 25.20 fails with workflow_timeout during the next controlling reconciliation.
21. **Commands and exit codes:** Every public command runs through the installed binary, and every normative exit code has at least one process test.
22. **Complete traceability:** The report contains no normative section, invariant, or success criterion without an associated test.
23. **Determinism:** Two consecutive suite executions in clean environments produce the same functional results without depending on accidental ordering or external network services.
24. **No omissions:** Execution fails if any conformance test is skipped, pending, or disabled.

## Required tests

- The twenty acceptance tests listed above, named to reference 25.1 through 25.20.
- Process tests for the CLI and signals.
- Tests using real temporary Git repositories.
- Controlled-clock tests for deadlines, leases, and retry delays.
- Fault injection across persistence and the Orca adapter.
- Automated validation of the traceability matrix.

## Traceability

- Complete PRODUCT.md: Sections 1 through 27.
- Normative scenarios: 25.1 through 25.20.
- Success criteria: 26.1 through 26.10.

## Definition of done

- The suite passes from a package installed in a clean environment.
- No tests are skipped, flaky, or dependent on uncontrolled external services.
- The matrix confirms coverage of every normative rule and identifies the test that provides evidence.
- All six commands, six run statuses, six error categories, and four exit codes are covered.
- The conformance report can be retained as v1 release evidence.
