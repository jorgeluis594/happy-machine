# Task 15: Certify the v1 public contract with a black-box E2E suite

## Objective

Automatically demonstrate that a clean Happy Machine installation satisfies the public v1 contract by exercising only the packaged product and its observable interfaces.

This task may create test infrastructure. It MUST NOT add, correct, or otherwise change product behavior.

## Functional value

Tasks 01 through 14 prove and own the individual capabilities. This task proves that those capabilities operate together through the interface available to a user. The suite provides reproducible release evidence without coupling conformance tests to production internals.

## Dependencies

- Tasks 01 through 14.

## E2E boundary

For this task, an end-to-end test MUST:

1. Package Happy Machine once for the suite execution.
2. Install that local package artifact into a clean temporary environment.
3. Create an isolated temporary project for the test.
4. Invoke the installed binary as an operating-system process through one or more of its seven public commands: `help`, `execute`, `status`, `history`, `resume`, `cancel`, and `cleanup`.
5. Observe only public effects and artifacts.

Tests MUST NOT import from `src/` or invoke application, domain, port, infrastructure, composition-root, or persistence modules directly. They MUST NOT create or modify run records or managed run files by hand.

The suite MAY observe:

- Process exit codes, stdout, and stderr.
- Output from `status` and `history`.
- Published document, event, error, and command contracts.
- Calls made to Orca and the values returned by Orca.
- Agent contexts delivered through the Orca boundary.
- Files produced in source and managed workspaces.
- Real Git repository, branch, commit, worktree, and dirty-state observations.

No other internal state is part of the E2E assertion surface.

## Fake Orca

- Provide one declarative fake Orca executable for the entire suite and select it only through the public `ORCA_CLI_COMMAND` environment variable.
- Configure behavior per test with fixture data rather than test-specific fake executables or production hooks.
- The fake MUST model successful and failed results, produced documents, event streams, question and escalation events, provenance/recovery lookup, cancellation, stop confirmation, delayed responses, and controllable blocking.
- The fake MUST record calls and received agent context in a form the tests can inspect.
- The fake MUST expose synchronization markers so tests can wait for specific lifecycle boundaries without relying on arbitrary sleeps.
- The suite MUST NOT invoke a real Orca installation, a real LLM agent, or any network service.

## Allowed changes

Task 15 changes are limited to:

- E2E fixtures and the declarative fake Orca.
- E2E helpers and assertions.
- Test-runner configuration.
- Package/install and suite execution scripts.
- Traceability and conformance-report generation.

Task 15 MUST NOT:

- Change production behavior, public APIs, commands, flags, environment variables, or types.
- Add test-only behavior or hooks to production code.
- Weaken, bypass, or replace a public contract for test convenience.
- Repair a functional gap discovered by the suite.

A functional gap MUST remain visible as a failing E2E test and be referred to the owning task from 01 through 14 for correction.

## Required coverage

- Keep one individually identifiable E2E test for each normative scenario `25.1` through `25.20` in `docs/PRODUCT.md`.
- Exercise all seven public commands through the installed binary.
- Exercise exit codes `0`, `1`, `2`, and `130` through real processes.
- Use real operating-system processes and signals for attach, detach, cancellation, and concurrent-controller behavior.
- Use a pseudo-TTY for interactive cleanup behavior.
- Use real temporary Git repositories and worktrees for Git-dependent scenarios.
- Cover Section 26 success criteria only where they are publicly demonstrable by Section 25 scenarios, commands, exit codes, or their retained evidence.

The E2E traceability matrix is intentionally limited to Section 25, Section 26, the seven commands, and the four public exit codes. It MUST NOT claim line-by-line coverage of Sections 1 through 27.

## Acceptance criteria

1. **Normal routing (`25.1`):** The test proves `needs_revision` publishes the expected documents and enters exactly the configured state.
2. **Unknown outcome (`25.2`):** The test proves attempt validation failure, stable retry context, and terminal failure after attempts are exhausted.
3. **Bounded cycle (`25.3`):** The test proves a new visit receives the prior draft and feedback in agent context.
4. **Fresh retry (`25.4`):** The test proves the retry receives a clean control workspace and partial outputs are not promoted.
5. **Failed source changes (`25.5`):** The test proves source-workspace changes persist but are excluded from `context.md` and routing.
6. **Parallel succeeded (`25.6`):** The test proves every parallel task settles before the aggregate succeeds.
7. **Parallel failed (`25.7`):** The test proves there is no fail-fast behavior and the aggregate is calculated only after all tasks settle.
8. **Parallel failure recovery (`25.8`):** The test proves `inspect_failures` receives successful documents and complete error summaries.
9. **Detach and resume (`25.9`):** A real-process signal test proves exit code `130`, absence of cancellation, recovery through `resume`, and no duplicate Orca execution.
10. **Concurrent controller (`25.10`):** Concurrent real processes prove `run_already_controlled` without mutation or duplicate execution.
11. **Attempt timeout (`25.11`):** Using the fake Orca's blocking and stop markers, the test proves retry does not begin until the previous execution is confirmed stopped.
12. **Question or escalation (`25.12`):** Fake event streams prove the attempt and its deadline remain active while a question or escalation is handled.
13. **Definition snapshot (`25.13`):** The test edits project definitions and proves `resume` uses the original snapshot while a new `execute` uses the changed files.
14. **External input snapshot (`25.14`):** The test edits an original input and proves the existing run retains and uses its copied input.
15. **Fan-out limitation (`25.15`):** A real Git test leaves the main worktree dirty and proves child worktrees start from `HEAD`.
16. **No automatic merge (`25.16`):** Real Git observations prove the join creates neither a commit nor a merge.
17. **Cancellation (`25.17`):** Real processes and fake cancellation markers prove evidence is preserved, the run reaches `canceled`, attached observation exits `2`, and `resume` is rejected.
18. **Cleanup prompt (`25.18`):** A pseudo-TTY test proves the prompt appears once, only after run termination, and retaining worktrees is the default.
19. **Dirty cleanup (`25.19`):** A real Git test proves cleanup protects uncommitted changes while preserving branches, commits, and history.
20. **Detached deadline (`25.20`):** A test uses a normative real timeout, detaches, waits with bounded polling, and proves the next controlling reconciliation fails with `workflow_timeout`.
21. **Commands:** Each of `help`, `execute`, `status`, `history`, `resume`, `cancel`, and `cleanup` is invoked by at least one test through the installed binary.
22. **Exit codes:** At least one real-process assertion covers each of `0`, `1`, `2`, and `130`.
23. **Clean installation:** The package is built and packed once per suite execution, and that local artifact is installed once into a fresh temporary environment from which all tests run, with no repository dependency leakage.
24. **Test isolation:** Every test creates a distinct project directory, state store, fake-Orca configuration, and Git repository when applicable.
25. **Deterministic synchronization:** Tests coordinate through fake-Orca markers and bounded polling. Arbitrary sleeps are forbidden. Real elapsed time is used only for the normative timeout behavior in `25.11`, `25.12`, and `25.20` when the public contract requires it.
26. **No omissions:** The suite fails if an E2E test is skipped, pending, disabled, focused exclusively, or lacks a traceability entry.
27. **Repeatability:** The full suite runs twice, each time with a new clean installation, and both runs produce identical functional results. Temporary paths, timestamps, process IDs, and other nonfunctional values may be normalized in the comparison.
28. **Public evidence report:** Each suite run emits a report containing the result and public evidence for every traced Section 25 scenario, applicable Section 26 criterion, command, and exit code. Uncovered or failing requirements make the report and suite fail.
29. **No product repair:** Task 15 is complete only when all E2E tests pass without a product behavior change made within this task.

## Required test infrastructure

- One declarative fake Orca selected by `ORCA_CLI_COMMAND`.
- Fixtures for projects, agents, prompts, workflows, Markdown inputs, fake results, documents, and events.
- Process helpers for signals, concurrent commands, exit-code capture, and bounded polling.
- A pseudo-TTY helper for interactive command tests.
- Helpers that create actual temporary Git repositories and inspect them with Git's public CLI.
- A pack-once/install-clean runner that can execute the suite twice with independent installations.
- Automated validation of skipped, pending, disabled, focused, and untraced tests.
- A machine-readable traceability manifest and generated public-evidence report.

## Explicit exclusions

- Internal clock injection or a production clock seam.
- Persistence fault injection and assertions about internal atomic write boundaries.
- Direct testing of leases, repositories, storage adapters, or internal controller implementation.
- Manual creation, editing, corruption, or deletion of durable run state.
- Exhaustive traceability for PRODUCT.md Sections 1 through 27.
- Real Orca, real LLM agents, uncontrolled external services, or network access.
- Performance, load, or scalability testing not required by the public v1 contract.
- Executors other than Orca.
- Capabilities explicitly excluded from v1, including a UI, global registry, human approval states, webhooks, daemon, parallel subflows, semantic merge, automatic commits or merges, rollback, executable configuration, and `on_failure`.

Atomicity internals, persistence failures, lease mechanics, repository behavior, and injected-clock tests remain the responsibility of the unit and integration suites owned by Tasks 01 through 14. Task 15 may assert only their publicly observable consequences when required by the E2E scenarios above.

## Traceability

The traceability manifest and generated report MUST cover exactly:

- Normative scenarios `25.1` through `25.20`.
- V1 success criteria `26.1` through `26.10`, mapped to public E2E evidence where applicable.
- Public commands `help`, `execute`, `status`, `history`, `resume`, `cancel`, and `cleanup`.
- Public exit codes `0`, `1`, `2`, and `130`.

Each entry MUST identify at least one E2E test and the public evidence it captures. The validation MUST reject missing entries and references to tests that did not run successfully.

## Public interfaces

This task adds or modifies no production API, command, flag, environment variable, or type. The suite consumes only the existing installed CLI contract and `ORCA_CLI_COMMAND`.

## Definition of done

- The suite passes twice from two clean installations of the same locally packed artifact.
- All twenty Section 25 E2E tests pass and are individually identifiable.
- All seven commands and all four public exit codes have passing real-process coverage.
- The traceability validator reports no omissions, disabled tests, or unsuccessful evidence.
- The generated report contains the result and public evidence for every requirement in the bounded matrix.
- The suite is independent of repository source imports, manually manipulated run state, real Orca or LLM agents, external networks, and uncontrolled timing.
- Any discovered functional gap has been left as a failing test and assigned back to its owning Task 01 through 14 rather than repaired in Task 15.
