# Happy Machine README Design

**Status:** Approved
**Date:** 2026-08-14

## Context

Happy Machine needs a public README that explains both what the repository does and why it exists. The product automates repeatable agent workflows as durable state machines. It was created in response to two recurring problems:

1. Complex work repeatedly followed the same sequence—research, product planning, technical planning, task management, implementation, QA, correction, and pull-request creation—but required manual coordination each time.
2. Long-running agents accumulated too much context and became unreliable. Delegating parts of the work to subagents did not provide sufficient isolation, so large implementation and validation stages still behaved inconsistently.

Happy Machine addresses those problems by running workflow tasks through fresh, isolated agents and by owning the workflow state outside any coordinating agent's conversation history.

## Audience and Positioning

The README is for a public developer audience and will be written in English. It must clearly identify Happy Machine as an experimental project under active development.

The opening should be problem-first rather than reference-first. It should explain the motivation and differentiator before presenting setup details.

## Central Message

Happy Machine separates nondeterministic agent work from deterministic workflow routing.

An agent performs one bounded task and returns a structured result containing a workflow-defined outcome. Happy Machine validates that result and follows the transition declared for that outcome. It does not ask a coordinator agent to infer the next step from prose.

This makes a workflow a directed state graph:

- States are nodes.
- Outcome transitions are directed edges.
- Terminal targets end execution.
- Backward transitions create explicit, bounded loops.
- Parallel states execute multiple tasks and join their results.

The README must not claim that agent execution itself is deterministic. Only routing after a valid outcome is deterministic.

## README Structure

The README will use the following order:

1. Project name, concise tagline, and experimental-status notice.
2. **The problem:** repeated workflows, context degradation, and unreliable agent-based coordination.
3. **How it works:** isolated agents, structured results, validated outcomes, and engine-owned transitions.
4. **Why deterministic orchestration matters:** the distinction between variable agent execution and explicit routing.
5. **Example workflow:** research → product planning → technical planning → task management → implementation ↔ QA → pull-request creation.
6. **Core capabilities:** conditional branches, bounded cycles, parallel tasks, retries and timeouts, durable recovery, cancellation, history, and Git worktree isolation.
7. **Getting started:** source-based setup, a minimal project definition, a minimal workflow, and core CLI commands.
8. **Architecture and current status:** links to the normative product contract and architecture document, plus the experimental warning.

## Workflow Example

The example should be small enough to understand at a glance while demonstrating the core differentiator. It will include the states `research`, `product_planning`, `technical_planning`, `task_management`, `implementation`, `qa`, and `create_pr`.

The essential routing example is:

```text
implementation → qa
qa.passed      → create_pr
qa.failed      → implementation
create_pr      → $succeeded
```

The final README should express this as valid workflow YAML and explain that global visit, transition, and timeout policies bound the QA loop.

## Getting Started Boundaries

Because the package is private and at version `0.0.0`, the README must not imply that Happy Machine is available from the public npm registry. Setup instructions will use the repository source and the currently supported Node.js version.

The quick start should cover:

- Node.js 22.18 or newer.
- Installing dependencies and building from source.
- The required Orca-based execution environment.
- Creating `happy-machine.yaml`, agent instruction files, and a workflow YAML file.
- Running CLI help and executing a workflow.

All commands and examples must be verified against the current package scripts, configuration parser, CLI help, and product contract before publication.

## Product Boundaries

The README should state or preserve these distinctions:

- Happy Machine coordinates agent work; it does not make business decisions on an agent's behalf.
- It validates structured results instead of deriving routing from free-form prose.
- It does not itself create commits, merge branches, or open pull requests. A project agent can perform those actions when its instructions and environment authorize them.
- Agent tasks receive isolated execution contexts while durable run state and declared Markdown documents carry the workflow forward.
- V1 is a CLI-oriented experimental system, not a graphical workflow builder.

## Validation

Before the README is considered complete:

- Every factual claim must agree with `docs/PRODUCT.md`.
- Architectural language must agree with `docs/ARCHITECTURE.md`.
- Configuration examples must parse under the current filesystem project-definition adapter.
- CLI commands must match the current help output.
- The sample workflow must demonstrate deterministic routing without implying deterministic agent behavior.
- Markdown formatting and repository checks must pass.
