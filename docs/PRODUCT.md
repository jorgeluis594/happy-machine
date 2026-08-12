# Happy Machine Product Contract

**Status:** Normative product definition for v1  
**Last updated:** 2026-08-10

## 1. Document Authority

This document defines the required logic, contracts, and externally observable behavior of Happy Machine v1.

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

The related documents have different responsibilities:

- [`superpowers/specs/2026-08-10-happy-machine-product-design.md`](superpowers/specs/2026-08-10-happy-machine-product-design.md) records the product intent and the design decisions that led to this contract.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) defines the permitted internal code structure and dependency direction.
- This document defines product behavior. When documents appear to conflict, this document governs behavior and `ARCHITECTURE.md` governs code placement.

## 2. Product Purpose

Happy Machine defines and executes durable agent workflows from plain-text project files. A workflow is a state machine whose states can branch, cycle, run agent tasks concurrently, and survive interruption without repeating recoverable work.

Happy Machine separates:

- Reusable agent instructions.
- Workflow definitions and routing rules.
- Run inputs and agent-produced Markdown documents.
- Machine-readable outcomes.
- Technical attempt failures.
- Durable execution history.
- Project filesystem changes made by agents.

The engine coordinates work. It does not infer workflow routing from prose, semantically merge documents, merge source-code changes, or decide business outcomes on behalf of an agent.

## 3. V1 Scope

### 3.1 Included

V1 includes:

- Self-contained projects described by YAML and Markdown.
- Project-local reusable agents.
- Normal and parallel workflow states.
- Closed outcome sets and explicit transitions.
- Forward branches and bounded cycles.
- Markdown document exchange through durable run context.
- Per-task timeouts and retries.
- Global run limits.
- Parallel task execution with an all-settled join.
- Durable run state, event history, detachment, recovery, cancellation, and cleanup.
- Direct project workspaces and optional Git worktree isolation.
- Orca as the default and only required executor.

### 3.2 Excluded

V1 does not include:

- A graphical interface.
- A global agent registry.
- Human approval states or Happy Machine commands for answering agent questions.
- Webhooks or other external workflow signals.
- A daemon that continues scheduling an entire workflow after the CLI detaches.
- Multi-state subflows running in parallel.
- Reusable subflow definitions.
- Automatic semantic document synthesis.
- Automatic commits, branch merges, patches, or filesystem rollback.
- Automatic propagation of uncommitted changes into child worktrees.
- Arbitrary executable code inside product configuration.
- An `on_failure` transition.

## 4. Product Concepts

### 4.1 Project

A project is a self-contained unit containing its configuration, local agent registry, workflows, prompts, and related source files. Its root is the directory containing `happy-machine.yaml`.

### 4.2 Agent

An agent is a project-local identifier associated with:

- A Markdown instruction file.
- A default model.

A workflow state or parallel task MAY override the default model. Tools, environment, and executor behavior come from the project and its Orca environment rather than from a global Happy Machine registry.

If an agent should commit source changes, that behavior MUST be declared in its instructions by the project author. Happy Machine itself never creates a commit.

### 4.3 Workflow

A workflow declares:

- An initial state.
- Normal and parallel states.
- The agent work performed by each state.
- The allowed outcome of each state.
- Exactly one transition target for each outcome.
- Optional policy overrides.
- One or more reachable terminal targets.

### 4.4 State

A state is one logical visit in a workflow.

- A normal state runs one agent task.
- A parallel state runs one or more agent tasks and joins their results.

Returning to a state through a cycle creates a new visit. Retrying a failed task does not create a new visit.

### 4.5 Task and Attempt

A task is one unit of agent work within a state. A normal state contains one implicit task. A parallel state contains explicitly named tasks.

An attempt is one execution of a task. `max_attempts` includes the initial attempt. For example, `max_attempts: 3` permits one initial attempt and up to two retries.

### 4.6 Outcome

An outcome is a valid routing value produced or calculated when a state completes.

- A normal state accepts one value from its workflow-defined closed outcome set.
- A parallel state accepts exactly the fixed outcomes `succeeded` and `failed`.

An outcome is not the same as a technical failure. A technical failure prevents a normal state from completing and is subject to retry. After retries are exhausted, the run fails because v1 has no `on_failure` transition.

### 4.7 Run

A run is one durable execution of a snapshotted workflow. It has a unique run ID and owns its state visits, attempts, documents, events, executor references, limits, and lifecycle status.

### 4.8 Project Workspace and Control Workspace

The project workspace is the directory in which an agent reads or changes project files. It is either the original project directory or a managed Git worktree.

The control workspace is an isolated directory owned by one task attempt. It contains the attempt's `context.md`, output directory, `result.json` destination, logs, and control metadata. Control workspaces are always isolated, including in direct mode.

## 5. Global Product Invariants

The following rules always apply:

1. A run uses immutable snapshots of its workflow definition and agent configuration.
2. A normal state completes with exactly one configured outcome.
3. A parallel state completes with exactly one engine-calculated outcome: `succeeded` or `failed`.
4. An outcome resolves to exactly one state or terminal target.
5. A transition is not scheduled until the preceding result is durably committed.
6. A retry never starts while the preceding attempt might still be active.
7. A run has at most one active Happy Machine controller.
8. Detaching the CLI never means canceling the run.
9. Committed workflow documents are immutable.
10. Only Markdown files explicitly declared by a valid successful attempt enter durable workflow context.
11. Happy Machine never commits, merges, reverts, or deletes user source changes.
12. An uncertain external execution is never duplicated.

## 6. Project Discovery and Storage

### 6.1 Project Discovery

Commands that require a project start from the workflow path or current directory and search upward for `happy-machine.yaml`. The nearest matching file defines the project root.

If no `happy-machine.yaml` is found, the command MUST fail before creating a run.

Configuration, workflow, instruction, and prompt paths MUST resolve relative to the discovered project root and MUST NOT escape it. CLI input documents are an explicit exception described in Section 10.

### 6.2 Durable Storage

Happy Machine stores project-local runtime state under:

```text
<project-root>/.happy-machine/
```

This location contains or references:

- The durable database.
- Run definition snapshots.
- Input and output documents.
- Event and executor logs.
- Attempt control workspaces.
- Controller lease data.
- Git worktree metadata.

Managed Git worktree directories MAY live outside `.happy-machine/` when required by Git, but their metadata MUST remain in the durable project store.

`.happy-machine/` SHOULD be excluded from version control. Cleaning worktrees MUST NOT delete the durable run database, history, logs, or committed workflow documents.

`history` is scoped to the discovered project.

## 7. Project Configuration Contract

`happy-machine.yaml` MUST declare schema version `1`.

```yaml
version: 1

executor:
  type: orca

workspace:
  mode: worktree # direct | worktree

agents:
  writer:
    instructions: agents/writer.md
    model: model-id
  reviewer:
    instructions: agents/reviewer.md
    model: model-id
  qa:
    instructions: agents/qa.md
    model: model-id
  security:
    instructions: agents/security.md
    model: model-id
  publisher:
    instructions: agents/publisher.md
    model: model-id

defaults:
  attempt_timeout: 30m
  max_attempts: 3
  retry_delay: 5s
  workflow_timeout: 24h
  max_state_visits: 10
  max_transitions: 100
  max_concurrency: 4
  controller_lease: 30s
```

### 7.1 Required Project Fields

- `version` MUST be `1`.
- `agents` MUST contain every agent referenced by a workflow.
- Each agent MUST declare an existing Markdown `instructions` file.
- Each agent MUST declare a non-empty default `model`.

### 7.2 Executor

`executor.type` defaults to `orca` when omitted. V1 does not require any other executor.

Happy Machine treats the configured project environment as executor input. It MUST NOT persist secret values merely to make a run snapshot. The run snapshot records declarative configuration and selected model identifiers; externally supplied secret values remain an operational dependency.

### 7.3 Workspace Mode

`workspace.mode` accepts:

- `direct`: agents use the original project directory.
- `worktree`: Happy Machine creates managed Git worktrees as described in Section 18.

The default is `direct`.

### 7.4 Default Policies

When omitted, the following values apply:

| Policy | Default | Meaning |
| --- | ---: | --- |
| `attempt_timeout` | `30m` | Wall-clock limit for one attempt. |
| `max_attempts` | `3` | Total attempts, including the first. |
| `retry_delay` | `5s` | Fixed wait after a confirmed failed attempt. |
| `workflow_timeout` | `24h` | Wall-clock deadline for the complete run. |
| `max_state_visits` | `10` | Maximum permitted visits to any one state. |
| `max_transitions` | `100` | Maximum permitted transitions in the run. |
| `max_concurrency` | `4` | Maximum simultaneously active tasks in a parallel state. |
| `controller_lease` | `30s` | Duration of the renewable controller lease. |

Policies resolve from least to most specific:

```text
project defaults → workflow overrides → state overrides → parallel task overrides
```

Only policies meaningful at a given level may be overridden there. For example, a task may override attempt timeout and retry policy, but it cannot override the run's global transition counter.

The supported override scopes are:

| Policy | Allowed scopes |
| --- | --- |
| `attempt_timeout` | Project, workflow, state, parallel task |
| `max_attempts` | Project, workflow, state, parallel task |
| `retry_delay` | Project, workflow, state, parallel task |
| `workflow_timeout` | Project, workflow |
| `max_state_visits` | Project, workflow |
| `max_transitions` | Project, workflow |
| `max_concurrency` | Project, workflow, parallel state |
| `controller_lease` | Project |

Durations MUST be positive. Counts MUST be positive integers. The effective concurrency of a parallel state is the smaller of its configured `max_concurrency` and its task count.

## 8. Workflow Definition Contract

A workflow is a YAML file with schema version `1`.

```yaml
version: 1
id: editorial-review
initial_state: draft

policies:
  workflow_timeout: 12h
  max_state_visits: 6

states:
  draft:
    type: agent
    agent: writer
    prompt_file: prompts/draft.md
    outcomes:
      completed: review
      rejected: $succeeded

  review:
    type: agent
    agent: reviewer
    prompt: Review the current draft and select the correct outcome.
    outcomes:
      approved: quality_checks
      needs_revision: draft
      rejected: $succeeded

  quality_checks:
    type: parallel
    max_concurrency: 2
    tasks:
      tests:
        agent: qa
        prompt: Run the project test suite and report the result.
      security:
        agent: security
        prompt_file: prompts/security-review.md
    outcomes:
      succeeded: publish
      failed: inspect_failures

  publish:
    type: agent
    agent: publisher
    prompt: Publish the approved result.
    outcomes:
      published: $succeeded

  inspect_failures:
    type: agent
    agent: reviewer
    prompt: Inspect the parallel task summary and document the failure.
    outcomes:
      documented: $failed
```

### 8.1 Common State Fields

Every state MUST declare:

- A unique state ID through its key in `states`.
- A supported `type`.
- A non-empty `outcomes` map.
- Exactly one of `prompt` or `prompt_file` when the state directly defines agent work.

A state or task MAY declare a model override and supported policy overrides.

`prompt` and `prompt_file` are mutually exclusive. The selected prompt is combined with the registered agent instructions and the generated context contract; it does not replace the agent instructions.

### 8.2 Normal States

A normal state uses `type: agent` and MUST reference exactly one registered agent.

Its outcome names are defined by the workflow author. Names such as `approved`, `needs_revision`, `rejected`, and `completed` have no built-in behavior. The engine only validates and resolves them.

The names `succeeded` and `failed` are not reserved in a normal state. If an author declares either name, it remains an ordinary semantic outcome. Terminal targets are distinguished by the `$` prefix.

### 8.3 Parallel States

A parallel state uses `type: parallel` and MUST declare one or more uniquely named tasks. Each task MUST declare:

- A registered `agent`.
- Exactly one of `prompt` or `prompt_file`.
- Optional model and retry policy overrides.

The state's outcomes map MUST contain exactly these keys:

```yaml
outcomes:
  succeeded: <target>
  failed: <target>
```

Individual parallel tasks also use only `succeeded` and `failed` in `result.json`.

### 8.4 Transition Targets

Every outcome target MUST be one of:

- The ID of another state.
- `$succeeded`, which completes the run successfully.
- `$failed`, which completes the run unsuccessfully by explicit workflow decision.

A negative business decision does not imply a failed run. For example, `rejected: $succeeded` means the workflow executed correctly and ended with a business rejection.

### 8.5 Cycles

Transitions MAY point to any state, including an earlier state or the same state. The engine applies identical state-entry behavior regardless of whether an edge is forward, backward, or self-referential.

Cycles are bounded by `max_state_visits`, `max_transitions`, and `workflow_timeout`.

### 8.6 No Failure Edge in V1

`on_failure` is not a v1 field. A technical failure is retried according to policy. If a normal task exhausts its attempts, the run ends as `failed`. A parallel task that exhausts its attempts contributes to the parallel state's valid aggregate `failed` outcome.

## 9. Definition Validation

Happy Machine MUST validate the complete effective definition before creating a run.

Validation MUST reject:

- An unsupported schema version.
- Duplicate YAML keys, state IDs, task IDs, or outcome names.
- Unknown configuration fields.
- A missing or unknown initial state.
- An unknown agent reference.
- A missing instruction or prompt file.
- Both or neither of `prompt` and `prompt_file` where exactly one is required.
- A missing, extra, or duplicated parallel outcome.
- An outcome without exactly one target.
- A target that is neither a declared state nor a terminal target.
- A reachable state that cannot reach either terminal target.
- A declared state that is unreachable from `initial_state`.
- Invalid, zero, or negative limits.
- An `on_failure` field.
- A `worktree` workspace mode when the project cannot support Git worktrees.
- Paths that escape the project root, except explicit CLI input paths.
- Arbitrary executable configuration.

Definition validation failure returns CLI exit code `1` and MUST NOT allocate a run ID or create durable run state.

## 10. Input Snapshot and `context.md`

### 10.1 Run Inputs

`execute` accepts zero or more `--input` arguments. Every input MUST be an existing, readable Markdown file.

An input MAY be outside the project root because the user selected it explicitly on the command line. Happy Machine copies every input into the run's immutable document store before the initial state starts. Later changes to the original file do not affect the run.

Duplicate basenames are allowed because every copied input receives a stable internal ID.

### 10.2 Definition Snapshot

At run creation, Happy Machine snapshots:

- `happy-machine.yaml` and the effective project configuration.
- The workflow file and effective policies.
- Every referenced agent instruction file.
- Every referenced prompt file and inline prompt.
- Resolved agent IDs, models, and model overrides.
- CLI input documents.

`resume` always uses this snapshot. Editing the project definition affects only later `execute` commands.

The complete project source tree is not copied as part of the definition snapshot. Its isolation behavior is controlled by workspace mode.

### 10.3 Context Snapshot

Each state visit receives a newly generated immutable context snapshot. Each task in the same parallel visit receives the same committed run context plus its own task prompt and control paths.

The parallel visit snapshot is fixed before fan-out. A parallel task never receives a sibling task's documents while the join is still open, even when concurrency limits cause that task to start later. Sibling results become available only to the state reached after the join.

`context.md` MUST index:

- Every snapshotted CLI input.
- Every document committed by successful earlier attempts.
- The producing state ID.
- The state visit number.
- The task ID when applicable.
- A stable immutable document path.
- For a completed parallel state, the status and error summary of each task.
- Managed worktree metadata needed by a later integration state.

The engine does not select documents semantically and does not define field-level mappings between states. Agents decide which indexed documents to read.

### 10.4 Stable Document Paths

Committed documents use provenance-based paths equivalent to:

```text
inputs/<input-id>/<original-name>.md
states/<state-id>/visits/<visit-number>/tasks/<task-id>/documents/<name>.md
```

A normal state's implicit task receives a stable engine-assigned task ID.

Two tasks MAY produce files with the same basename because their provenance paths differ. A committed file MUST NOT be overwritten. A later state may produce a new version under its own provenance path.

## 11. Task Launch Contract

Before launching an attempt, Happy Machine materializes:

- The immutable `context.md` path.
- A task-specific output directory.
- The required `result.json` path.
- The selected project workspace path.
- The merged agent instructions and task prompt.
- The effective model, timeout, and attempt number.

Happy Machine automatically appends the required structured-result contract to
the effective task prompt. The generated block includes the exact output and
`result.json` paths, the permitted semantic outcomes without their destination
states, and the required result shape. Workflow authors provide only the task
prompt and do not repeat this protocol.

The Orca adapter MUST communicate these paths unambiguously to the agent. The project workspace and control workspace are logically separate even if an adapter chooses a particular physical layout.

The attempt identity is stable and consists of:

```text
run ID + state ID + visit number + task ID + attempt number
```

This identity MUST be persisted before external launch and MUST be included in executor provenance so recovery can find a launch that completed during a controller crash.

## 12. `result.json` Contract

### 12.1 Normal Task Result

A successful normal task MUST create:

```json
{
  "outcome": "approved",
  "documents": [
    "review.md"
  ]
}
```

`outcome` MUST match exactly one key in the current state's snapshotted outcomes map.

### 12.2 Parallel Task Result

A parallel task MUST use exactly one of the fixed outcomes:

```json
{
  "outcome": "succeeded",
  "documents": [
    "test-report.md"
  ]
}
```

or:

```json
{
  "outcome": "failed",
  "documents": [],
  "error": {
    "code": "tests_failed",
    "message": "The integration test suite did not pass."
  }
}
```

An agent-declared parallel `failed` result is a failed attempt and is retryable. If it remains failed after all attempts, the task's final status is failed and the parallel state later emits aggregate outcome `failed`.

### 12.3 Result Validation

For every task, Happy Machine MUST verify that:

- `result.json` exists at the assigned path.
- It is valid JSON with one string `outcome` and one `documents` array.
- The outcome is valid for the state type.
- Every document entry is a relative path.
- Canonicalizing the path does not escape the attempt's assigned output area.
- Every referenced file exists, is a regular file, and has a `.md` extension.
- No referenced document collides with an already committed provenance path.
- An optional `error`, when present, contains only serializable diagnostic data.

Missing or invalid `result.json`, an unknown outcome, and an invalid document reference are technical attempt failures.

Happy Machine MUST ignore free-form standard output when selecting an outcome. Standard output and standard error remain logs.

## 13. Document Commit Rules

After a valid successful attempt, Happy Machine:

1. Copies or content-addresses the declared Markdown files into the durable run store.
2. Records their hashes and provenance.
3. Persists the valid outcome.
4. Persists the state transition decision.
5. Makes the documents visible to later state visits.

These changes form one logical commit. The next state MUST NOT start before that commit succeeds.

Files produced by a failed or invalid attempt are retained only as audit material. They MUST NOT appear as committed workflow documents and MUST NOT enter a later `context.md` automatically.

Project filesystem changes are separate from workflow documents. A failed attempt may leave source changes in the direct directory or worktree. Happy Machine does not roll them back. Their presence MUST NOT create outcomes, transitions, or committed context entries. Only a valid `result.json` can do that.

## 14. Normal State Execution

A normal state follows this sequence:

1. Verify the run is active, controlled, within its deadline, and below all limits.
2. Create the state visit and immutable context snapshot.
3. Resolve the registered agent, prompt, model, and policies from the run snapshot.
4. Create and persist the attempt identity.
5. Launch or recover the Orca execution.
6. Wait for a terminal executor result or attempt timeout.
7. Validate `result.json` and declared documents.
8. If the attempt failed, apply the retry contract in Section 16.
9. If the attempt succeeded, durably commit its result.
10. Resolve exactly one configured transition.
11. Enter the target state or terminal run status.

If all attempts are exhausted, the run ends as `failed` with the last failure and complete attempt history.

## 15. Parallel State Execution

### 15.1 Scheduling

A parallel state creates one task for every declared task definition. It starts at most `max_concurrency` tasks at once.

When a task finishes, the engine MAY start the next queued task. A failed task does not stop scheduling queued tasks and does not cancel running tasks.

Every task has its own:

- Agent and prompt.
- Model override.
- Control workspace.
- Attempts and retry budget.
- Executor IDs.
- Documents and logs.
- Final task status.

### 15.2 Join Rule

The parallel state uses an all-settled join:

- It waits until every task has either succeeded or exhausted its attempts.
- It emits `succeeded` only when every task succeeded.
- It emits `failed` when one or more tasks exhausted their attempts.
- It preserves every successful document and every failure record.
- It never performs semantic synthesis or source-code merge.

The aggregate outcome is calculated by the engine, not selected by one task.

### 15.3 Failed Parallel Transition

`failed` is a valid parallel state outcome, not an `on_failure` edge. The workflow MUST map it to another state or a terminal target.

The destination context includes:

- Documents committed by successful parallel tasks.
- Each task's final `succeeded` or `failed` status.
- Attempt counts and final error summaries.
- References to retained audit material and managed worktrees.

Partial files from failed attempts remain audit-only and are not promoted as ordinary workflow documents.

### 15.4 Engine-Level Failure

If the engine cannot safely calculate or persist the aggregate result—for example, because an external execution remains irreconcilably uncertain—the run ends as `failed`. The engine MUST NOT fabricate aggregate `failed` merely to hide an infrastructure uncertainty.

## 16. Retry and Timeout Contract

### 16.1 Retryable Failures

The following failures consume an attempt and are retryable until `max_attempts` is exhausted:

- Orca reports task or worker failure.
- A normal executor process exits without a valid result.
- A parallel task declares `failed`.
- `result.json` is missing or malformed.
- The outcome is absent or invalid.
- A declared document is absent, outside the output area, or not Markdown.
- `attempt_timeout` expires and the old attempt is confirmed stopped.

### 16.2 Fresh Retry Context

A retry receives:

- The same immutable state-visit context snapshot.
- The same agent instructions and task prompt.
- The next attempt number.
- A clean control workspace.
- No partial documents from the failed attempt.

A retry does not receive a new state visit and does not increment `max_state_visits` or `max_transitions`.

Fresh retry context does not mean project filesystem rollback. Source changes left by the failed attempt remain present in the selected direct directory or worktree. The engine does not index those files as workflow context and does not use them to route the workflow.

### 16.3 Retry Delay

After confirming an attempt failure, Happy Machine waits the effective fixed `retry_delay` before starting the next attempt.

### 16.4 Attempt Timeout

When `attempt_timeout` expires, Happy Machine:

1. Marks the attempt as timing out.
2. Requests cancellation through Orca.
3. Reconciles until it confirms the old execution is no longer active.
4. Starts a retry only after that confirmation.

If Orca cannot confirm whether the attempt stopped, Happy Machine MUST NOT launch a duplicate. If the uncertainty cannot be resolved safely, the run ends as `failed`.

The attempt deadline continues while the CLI is detached. Because v1 has no daemon, an attempt that expires while detached is canceled and reconciled by the next controller that resumes or cancels the run.

### 16.5 Orca Questions and Escalations

Structured Orca `question` and `escalation` events do not fail the attempt and do not change the workflow state. Happy Machine records and displays them while the attempt continues to consume its normal timeout.

The event MAY be resolved externally through Orca. V1 provides no Happy Machine answer or approval command. If the task does not complete before its attempt timeout, the ordinary timeout and retry rules apply.

## 17. Cycles, Visits, and Global Limits

### 17.1 Cycle Entry

When an outcome transitions back to a previously visited state, Happy Machine creates a new visit and applies the same state-entry algorithm used for every other transition.

The new visit receives a fresh context snapshot containing all committed documents available at that point, including documents from earlier visits to the same state and feedback produced between visits.

This differs from a retry, which reuses the original visit and original context snapshot.

### 17.2 State Visit Limit

`max_state_visits: N` permits at most `N` entries into any one state. Attempting an `(N + 1)`th visit ends the run as `failed` with `max_state_visits_exceeded`.

### 17.3 Transition Limit

`max_transitions: N` permits at most `N` resolved outcome edges, including edges to terminal targets. Attempting an `(N + 1)`th transition ends the run as `failed` with `max_transitions_exceeded`.

### 17.4 Workflow Timeout

`workflow_timeout` is a wall-clock deadline measured from durable run creation. It continues while:

- The CLI is detached.
- An Orca task is running.
- A question or escalation is pending.
- A retry delay is active.

When the deadline expires under an attached controller, Happy Machine stops scheduling new work, requests cancellation of active work, preserves all evidence, and ends the run as `failed` with `workflow_timeout` once cancellation is reconciled as far as safely possible.

When it expires while detached, no background Happy Machine daemon acts on it. The next controller to resume or cancel the run detects the expired deadline before scheduling work, reconciles or cancels active Orca executions, and records terminal `failed` with `workflow_timeout`.

Global limit failures do not produce outcomes and cannot be routed in v1.

## 18. Workspace Behavior

### 18.1 Direct Mode

In `direct` mode:

- Agents use the original project directory as their project workspace.
- Sequential and parallel agents MAY read or modify the same files.
- Happy Machine does not block parallel states or require a shared-write opt-in.
- The workflow author accepts the risk of source-file conflicts.
- Control workspaces and workflow document destinations remain isolated per attempt.

This mode supports parallel read-only exploration, QA, and testing without requiring Git worktrees.

### 18.2 Worktree Mode

In `worktree` mode:

- Happy Machine creates one main worktree for the run.
- The main worktree starts from the original project's current `HEAD` at run preparation time.
- Uncommitted changes in the original project directory are not copied into, validated for, or rejected by the main worktree.
- Sequential states use the run's main worktree.
- Each parallel task receives a separate child worktree.
- Each child worktree starts from the current `HEAD` of the main run worktree when the parallel state begins.
- Uncommitted changes in the main worktree are not copied, propagated, validated, or rejected before fan-out in v1.
- The workflow author is responsible for instructing an earlier agent to commit changes when parallel children must inherit them.
- Happy Machine records each managed path, branch, starting and ending `HEAD`, and dirty status.
- Happy Machine never commits or merges changes.
- A later integration state MAY inspect recorded worktree paths and branch references and perform integration according to its agent instructions.

Removing a worktree does not authorize Happy Machine to delete its branch or commits.

### 18.3 Worktree Retention and Cleanup

Managed worktrees are retained after `succeeded`, `failed`, or `canceled` completion.

When an attached interactive `execute`, `resume`, or `cancel` command observes the complete run enter a terminal status, the CLI asks exactly once whether managed worktrees should be cleaned up. It MUST NOT ask after a state, task, attempt, or parallel join.

The default answer is to retain worktrees. When there is no interactive terminal, no controller is attached, or the user does not answer, Happy Machine retains them.

If cleanup is requested:

- Clean managed worktrees may be removed.
- A worktree with uncommitted changes MUST NOT be removed.
- The CLI reports every worktree that requires attention.
- Durable run history, documents, logs, branches, and commits remain intact.

`happy-machine cleanup <run-id>` offers the same cleanup behavior later. In direct mode it reports that there are no managed worktrees to remove.

## 19. Durability and Atomicity

### 19.1 Source of Truth

The durable project store is the source of truth for:

- Runs and statuses.
- State visits.
- Tasks and attempts.
- Effective policies.
- Executor provenance.
- Inputs and committed documents.
- Outcomes and transitions.
- Errors and cancellation requests.
- Controller leases.
- Worktree metadata.
- Ordered events.

In-memory queues, running processes, cached context, and concurrency counters are disposable and MUST be reconstructable.

### 19.2 Attempt Launch Atomicity

Before calling Orca, the engine persists an attempt in `launching` status with its stable attempt identity. After Orca returns stable identifiers, the engine persists them before treating the attempt as running.

If the controller fails between external launch and identifier persistence, recovery MUST search Orca provenance using the stable attempt identity before deciding whether launch occurred. It MUST NOT start another attempt merely because the local record lacks a final external ID.

### 19.3 Completion Atomicity

An attempt result is not complete until one durable operation has recorded:

- Validated result contents.
- Durable document references and hashes.
- Attempt terminal status.
- State outcome when applicable.
- The selected transition or parallel task contribution.
- Ordered history events.

If a crash happens after files are written but before the commit, those files are unreferenced audit material. Recovery does not treat them as committed documents.

### 19.4 Snapshot Reproducibility

Editing configuration, workflows, prompts, agent instructions, or model defaults after `execute` does not change an existing run. `resume` always uses the original snapshot.

Source changes in a direct workspace and external environment values are not immutable product-definition snapshots. Reproducing those dependencies remains the project author's responsibility.

## 20. Orca Executor Contract

Happy Machine integrates with Orca through a technology-specific adapter while preserving product-level executor invariants.

The adapter MUST:

- Use machine-readable JSON responses for lifecycle operations.
- Associate each Orca task and dispatch with the stable Happy Machine attempt identity.
- Persist the Orca task ID, dispatch ID, and terminal handle when available.
- Inspect existing task and dispatch state before launch, retry, resume, or cancellation.
- Consume completion, question, and escalation events without using free-form text as workflow control.
- Read logs without treating them as outcomes.
- Request cancellation and reconcile the resulting worker state.
- Release executor resources only after durable result handling.
- Translate Orca failures into technology-independent attempt errors.

Orca lifecycle states such as `start_unknown` and `stop_unknown` represent uncertainty, not permission to retry. The adapter MUST continue reconciliation or fail safely without duplicating work.

The exact Orca command sequence is an adapter implementation concern and may evolve without changing this product contract, provided these invariants remain true.

## 21. Run Lifecycle

### 21.1 Run Statuses

V1 exposes these run statuses:

| Status | Meaning |
| --- | --- |
| `running` | A controller holds the lease and is scheduling or observing work. |
| `detached` | No controller is active; an existing Orca task may still be running. |
| `canceling` | Cancellation is durable and active work is being stopped or reconciled. |
| `succeeded` | A workflow transition reached `$succeeded`. |
| `failed` | A transition reached `$failed` or an unrecoverable product/runtime failure occurred. |
| `canceled` | Explicit cancellation completed. |

`succeeded`, `failed`, and `canceled` are terminal.

### 21.2 Detachment

`Ctrl+C`, terminal closure, or controller loss does not cancel a run.

After detachment:

- Happy Machine schedules no new state or retry.
- Already launched Orca work may continue.
- The lease is released explicitly or expires.
- The durable run becomes or is observed as `detached`.
- The workflow deadline continues.

V1 has no daemon that continues orchestration while detached.

### 21.3 Resume

`resume`:

1. Loads the run snapshot.
2. Rejects a terminal run.
3. Acquires the controller lease.
4. Reconciles every nonterminal attempt using persisted Orca identifiers and provenance.
5. Persists any completed results discovered during reconciliation.
6. Applies timeouts and global limits.
7. Only then schedules pending work.

If an existing attempt remains active, `resume` observes it rather than creating another attempt.

### 21.4 Controller Lease

Only one process may control a run. The controller renews a durable lease before its effective `controller_lease` period expires.

A second controller receives `run_already_controlled` and MUST NOT mutate the run. A read-only `status` or `history` command does not acquire the controller lease.

An expired lease permits another controller to attempt recovery; it does not by itself prove that external work stopped.

### 21.5 Cancellation

`cancel` is explicit, durable, and irreversible.

When accepted, it:

1. Persists the cancellation request.
2. Stops scheduling new tasks and retries.
3. Moves the run to `canceling`.
4. Requests cancellation of every active Orca execution.
5. Reconciles their final states.
6. Preserves history, documents, logs, source changes, and worktrees.
7. Moves the run to `canceled`.

A canceled run cannot be resumed. Calling `cancel` for an already terminal run reports its existing status and does not change it.

If the controller disappears while cancellation is in progress, `canceling` remains durable. A later cancellation reconciliation MUST continue stopping work rather than resume normal scheduling.

## 22. CLI Contract

### 22.1 Commands

```text
happy-machine execute <workflow.yaml> [--input <document.md> ...]
happy-machine status <run-id>
happy-machine history [<run-id>]
happy-machine resume <run-id>
happy-machine cancel <run-id>
happy-machine cleanup <run-id>
```

### 22.2 Execute

`execute`:

1. Discovers the project.
2. Parses and validates the effective definition.
3. Snapshots definitions and inputs.
4. Allocates and prints the run ID.
5. Acquires the lease.
6. Prepares the selected project workspace.
7. Starts the initial state.
8. Remains attached until terminal completion or detachment.

### 22.3 Status

`status` is read-only and reports at least:

- Run ID, workflow ID, and definition snapshot identity.
- Run status and terminal reason when present.
- Controller attachment and lease status.
- Current state and visit.
- Active, queued, succeeded, and failed tasks.
- Attempt numbers, effective deadlines, and retry timing.
- Pending question or escalation events.
- Last committed outcome and transition.
- Worktree paths and dirty status when applicable.

### 22.4 History

Without a run ID, `history` lists project runs in reverse chronological order. With a run ID, it shows the ordered event history needed to explain:

- Which definition snapshot ran.
- Which state and task started each attempt.
- Why an attempt retried or failed.
- Which outcome completed a state.
- Which transition was selected.
- When the controller detached or resumed.
- What caused terminal completion.

### 22.5 Exit Codes

Attached execution commands use:

| Code | Meaning |
| ---: | --- |
| `0` | The run completed as `succeeded`, or a read-only/cleanup command succeeded. |
| `1` | The run completed as `failed`, definition validation failed, or the command encountered an operational error. |
| `2` | The run completed as `canceled`. |
| `130` | The user detached with `Ctrl+C`; the run was not canceled. |

Printing a run ID does not imply exit code `0`; `execute` remains attached and returns the code associated with its eventual observed result.

## 23. Error Taxonomy

### 23.1 Definition Errors

Definition errors occur before run creation and include invalid YAML, invalid paths, unknown agents, invalid graph structure, and invalid policies. They return exit code `1` and create no run.

### 23.2 Attempt Failures

Attempt failures are recorded against one attempt and may be retried. They include executor failure, timeout with confirmed stop, invalid result, invalid outcome, and invalid document output.

### 23.3 Parallel Aggregate Failure

Parallel aggregate `failed` is a valid state outcome. It means at least one task exhausted its attempts while the engine still completed and persisted the all-settled join.

### 23.4 Run Failures

Run failures are terminal and include:

- A normal task exhausting all attempts.
- A transition reaching `$failed`.
- `workflow_timeout`.
- `max_state_visits_exceeded`.
- `max_transitions_exceeded`.
- Irreconcilable executor uncertainty.
- Durable storage corruption or inability to commit state safely.
- Failure to create a required project workspace after run creation.

### 23.5 Command Conflicts

Command conflicts such as `run_already_controlled` reject the command without changing the run's workflow state.

### 23.6 Cancellation

Cancellation is not a failure and does not produce an outcome. It produces terminal run status `canceled`.

## 24. Observability Requirements

Every important event MUST be durable and causally attributable. The event history MUST include:

- Run creation and definition snapshot identity.
- Lease acquisition, renewal loss, detachment, and recovery.
- State entry with visit number.
- Task queuing and scheduling.
- Attempt launch identity and executor references.
- Attempt timeout, cancellation, result, and retry decision.
- Orca question and escalation events.
- Document commit with hash and provenance.
- State outcome and selected target.
- Parallel join calculation and per-task summary.
- Global limit evaluation.
- Cancellation request and completion.
- Worktree creation, observed state, and cleanup decision.
- Terminal run status and reason.

Events MUST be ordered within a run. Logs MAY be stored separately, but every log stream MUST be attributable to a run, state visit, task, and attempt.

## 25. Acceptance Scenarios

The following scenarios are normative examples of required behavior.

### 25.1 Normal Dynamic Routing

**Given** a normal `review` state allows `approved` and `needs_revision`  
**When** its valid `result.json` declares `needs_revision`  
**Then** the engine commits its Markdown documents and enters exactly the configured revision state.

### 25.2 Unknown Normal Outcome

**Given** a normal state does not declare `uncertain`  
**When** an attempt returns `uncertain`  
**Then** the attempt fails validation, retries with the same context snapshot, and the run fails if all attempts are exhausted.

### 25.3 Bounded Cycle

**Given** `review` routes `needs_revision` back to `draft`  
**When** that route is selected  
**Then** a new `draft` visit receives the previous draft and review feedback through a fresh `context.md`.

### 25.4 Fresh Retry

**Given** an attempt writes partial output and then times out  
**When** Orca confirms it stopped and the engine retries  
**Then** the retry receives the original visit context, a clean control workspace, and no promoted partial documents.

### 25.5 Filesystem Changes From a Failed Attempt

**Given** a failed attempt modified source files in its selected project workspace  
**When** the attempt retries  
**Then** Happy Machine does not roll back those files, but it also does not add them to `context.md` or use them to choose a transition.

### 25.6 Successful Parallel Join

**Given** a parallel state has three tasks  
**When** all three eventually return `succeeded`  
**Then** the engine emits aggregate `succeeded` after all three settle and follows its configured transition.

### 25.7 Failed Parallel Join

**Given** one parallel task exhausts its attempts  
**When** the remaining tasks are still queued or running  
**Then** the engine continues all tasks, preserves their results, waits for all to settle, and emits aggregate `failed`.

### 25.8 Parallel Failure Recovery State

**Given** a parallel state's `failed` outcome targets `inspect_failures`  
**When** the join emits `failed`  
**Then** `inspect_failures` receives successful task documents and a summary of every task's final result and errors.

### 25.9 Detach and Resume

**Given** an Orca task is active  
**When** the user presses `Ctrl+C`  
**Then** the CLI exits `130`, the run becomes detached, the Orca task may continue, and no new work is scheduled.

**When** the user later resumes the run  
**Then** Happy Machine reconciles the existing task before scheduling anything and never duplicates it.

### 25.10 Concurrent Controller

**Given** one controller holds a valid lease  
**When** another process calls `resume`  
**Then** the second process receives `run_already_controlled` and the run is unchanged.

### 25.11 Attempt Timeout

**Given** an attempt exceeds its timeout  
**When** cancellation is requested  
**Then** no retry starts until Orca confirms the preceding attempt stopped.

### 25.12 Question or Escalation

**Given** Orca emits a structured question or escalation  
**When** the event remains unanswered  
**Then** the attempt remains active and its timeout continues; the event alone does not produce `failed`.

### 25.13 Definition Snapshot

**Given** a run has started  
**When** the project workflow or agent instructions change  
**Then** `resume` continues using the original run snapshot and a new `execute` uses the changed files.

### 25.14 External Input Snapshot

**Given** the user supplies a Markdown input outside the project  
**When** the run starts and the original file later changes  
**Then** the run continues using its immutable copied input.

### 25.15 Worktree Fan-Out Limitation

**Given** the main run worktree has uncommitted changes  
**When** a parallel state creates child worktrees  
**Then** the children start from the main worktree's current `HEAD`; Happy Machine neither propagates nor rejects the uncommitted changes.

### 25.16 No Automatic Merge

**Given** parallel agents modify their child worktrees  
**When** the parallel state joins  
**Then** Happy Machine records the worktree references but creates no commit and performs no merge.

### 25.17 Cancellation

**Given** a run is active  
**When** the user calls `cancel`  
**Then** Happy Machine stops scheduling, requests cancellation, preserves evidence, and ends as `canceled`; later `resume` is rejected.

### 25.18 Cleanup Prompt

**Given** the complete run reaches a terminal status in an interactive attached CLI  
**When** managed worktrees exist  
**Then** Happy Machine asks once whether to clean them up, defaults to retaining them, and never asks after individual steps.

### 25.19 Dirty Worktree Cleanup

**Given** cleanup is requested for a dirty managed worktree  
**When** Happy Machine evaluates it  
**Then** it refuses to remove that worktree and reports it without deleting source changes, branches, commits, or run history.

### 25.20 Global Deadline While Detached

**Given** a run is detached  
**When** its workflow deadline passes  
**Then** the elapsed time still counts; on the next controlling reconciliation Happy Machine cancels active work as safely as possible and records terminal `failed` with `workflow_timeout`.

## 26. V1 Success Criteria

V1 satisfies this contract when a user can:

1. Create a self-contained project with reusable local agents and one or more workflows.
2. Validate definitions before run creation.
3. Execute dynamic normal-state branches and bounded cycles.
4. Exchange multiple immutable Markdown documents across state visits.
5. Run parallel tasks with independent retries and a deterministic all-settled outcome.
6. Distinguish semantic outcomes, parallel aggregate failure, technical attempt failure, run failure, and cancellation.
7. Detach and resume without repeating recoverable Orca work.
8. Inspect a causal history that explains every transition and retry.
9. Choose direct or worktree project isolation while retaining explicit responsibility for source control.
10. Share versioned project definitions and obtain the same workflow behavior from new runs using those files.

## 27. External Integration Reference

The Orca adapter design is informed by the current Orca orchestration lifecycle and its machine-readable task, dispatch, worker, and delivery concepts. Orca documentation is non-normative for Happy Machine behavior; changes in Orca commands must be absorbed by the outbound adapter without weakening this contract.

- [Orca orchestration guide](https://github.com/stablyai/orca/blob/main/skill-guides/orchestration.md)
