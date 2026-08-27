# Dynamic Parallel Fan-Out Design

## Status

Approved for implementation planning on 2026-08-26.

## Goal

Allow an agent state to produce an ordered collection of work items whose
runtime size determines how many fresh agent tasks a later parallel state
creates. The producer publishes data only. The workflow definition, rather
than the producer, selects the worker agent, prompt, concurrency, retries, and
transitions.

The feature extends the existing bounded parallel scheduler and all-settled
join. It does not create states dynamically or mutate the snapshotted workflow
graph.

## Product Decisions

- A producer declares a named structured output with type `work_items`.
- A work-item collection is an ordered JSON array of objects.
- Every item has one required engine field: a unique stable `id`.
- All other item fields are opaque JSON data.
- The output declaration owns `max_items`, which defaults to `100`.
- A dynamic parallel state selects one agent and one prompt template for every
  item in the collection.
- `max_concurrency` controls active agents. Setting it to `1` processes the
  collection sequentially; larger values process it through the existing
  bounded worker pool.
- An empty collection is valid and joins immediately with `succeeded` without
  launching an agent.
- Existing static parallel states keep their current syntax and behavior.

## Configuration Interface

### Producer

An agent state may declare one or more named outputs under `produces`:

```yaml
states:
  plan_tasks:
    type: agent
    agent: planner
    prompt: Divide the requested work into independent implementation tasks.
    produces:
      tasks:
        type: work_items
        max_items: 100
    outcomes:
      completed: implement_tasks
```

For the initial feature, `work_items` is the only supported structured output
type. `max_items` is optional, is a positive integer when present, and resolves
to `100` when omitted.

Every valid result from a state with `produces` must include all its declared
outputs. A producer that has no work for a collection returns an empty array.
This keeps the result contract closed and prevents a downstream consumer from
having to distinguish an absent output from an intentionally empty one.

### Dynamic Parallel Consumer

A parallel state may replace its static `tasks` map with one `for_each` source
and one `task` template:

```yaml
  implement_tasks:
    type: parallel
    for_each:
      from: plan_tasks.outputs.tasks
    task:
      agent: implementer
      prompt: Implement the assigned work item and validate the focused change.
      max_attempts: 2
    max_concurrency: 4
    outcomes:
      succeeded: qa
      failed: inspect_failures
```

The source syntax is exactly `<state-id>.outputs.<output-name>`. The referenced
state and output must exist in the same workflow, and the output must declare
`type: work_items`.

A parallel state must use exactly one task-definition form:

- `tasks`: the existing non-empty map of statically named tasks; or
- `for_each` plus `task`: a runtime collection and one shared work template.

The two forms are mutually exclusive. A dynamic `task` supports the same agent,
prompt, prompt-file, timeout, retry-count, and retry-delay fields as an existing
static parallel task. Runtime and reasoning remain properties of the selected
agent profile.

The dynamic state's outcomes remain exactly `succeeded` and `failed`.

## Structured Result Contract

The generated result instructions for the producer include its declared output
names, types, limits, and required shape. A valid producer result is equivalent
to:

```json
{
  "outcome": "completed",
  "outputs": {
    "tasks": [
      {
        "id": "implement-auth",
        "title": "Implement authentication",
        "spec_path": "tasks/implement-auth.md"
      },
      {
        "id": "add-session-tests",
        "title": "Add session tests",
        "spec_path": "tasks/add-session-tests.md"
      }
    ]
  },
  "documents": []
}
```

For each declared `work_items` output, validation requires:

- an array whose length does not exceed effective `max_items`;
- every member to be a JSON object, not `null` or an array;
- an own `id` property containing a valid Happy Machine identifier;
- unique IDs within that collection;
- only JSON-compatible values in every other field.

Unknown top-level result fields, undeclared output names, missing declared
outputs, invalid items, duplicate IDs, and excess items invalidate the attempt.
The normal retry policy applies. Outputs from invalid or exhausted attempts are
audit evidence only and never become workflow data.

Parallel workers retain the existing fixed result outcomes `succeeded` and
`failed`. They do not produce or select the aggregate state outcome.

## Definition Model

The effective definition distinguishes two parallel variants while retaining
the public state type `parallel`:

- a static variant containing `tasks`;
- a dynamic variant containing a `forEach` source and an `AgentWorkDefinition`
  template.

A normal state may contain a map of structured-output definitions. The source
reference in a dynamic state is resolved and validated while loading the full
workflow definition. The effective definition snapshot includes output
declarations, effective item limits, source references, and the dynamic work
template. Resume never reads edited project YAML for these values.

The graph remains composed solely of declared states and outcome edges. A
dynamic collection affects task cardinality within one parallel visit, not
reachability or transitions.

## Durable Output Commit

After a producer returns a valid result, Happy Machine stages its documents and
structured outputs. The transition commit atomically records:

- the producing state and visit;
- the validated outcome and target;
- declared documents;
- every structured output with its name, type, ordered value, durable path,
  and content hash;
- the normal transition and output-commit events.

No consumer may observe the structured output before this commit succeeds.
Structured outputs are immutable after commit. Later visits to the same
producer create new provenance records rather than overwriting earlier values.

The full output value is stored as a durable JSON artifact. Run state retains
the metadata needed to locate and verify it; event history records names,
counts, provenance, and hashes rather than duplicating the entire payload.

## Source Resolution and Materialization

When a dynamic parallel state is entered, Happy Machine resolves its source to
the most recent committed visit of the referenced producer that precedes the
new consumer visit and contains the named output. This rule is deterministic
for cycles: a later producer visit supersedes an earlier one only for consumer
visits created after the later output was committed.

If no committed source exists, the run terminates with engine failure
`dynamic_source_unavailable`. This can occur when an alternative route reaches
the consumer without first committing its declared source. The engine does not
fabricate the aggregate outcome `failed` because no trustworthy task set was
created.

At state entry, the engine reads and verifies the committed output artifact,
then materializes one durable parallel task for every item in array order. Each
task records:

- `id`, copied exactly from `work_item.id`;
- its complete immutable work-item value;
- source state, source visit, and output-name provenance;
- queued status, attempts, documents, errors, and workspace metadata already
  used by static parallel tasks.

The visit records the resolved source and complete task list before any
external task launch. A collection with zero items is still a valid materialized
visit.

Materialization must persist successfully before worktree preparation, context
creation, or scheduling. A persistence or artifact-integrity failure is an
engine-level run failure.

## Task Context and Isolation

All dynamic siblings derive their context from the same frozen visit-level
snapshot of committed inputs, documents, outputs, completed joins, and
workspace metadata. Each dynamic task receives an immutable task-specific
`context.md` that adds exactly its own work item:

````markdown
## Work item

```json
{
  "id": "implement-auth",
  "title": "Implement authentication"
}
```
````

The JSON representation is deterministic. The engine does not interpolate item
properties into the author prompt and does not interpret any opaque field.
This avoids adding a template language and keeps the workflow prompt reusable.

Retries of one task reuse the same task context and work item. A task never
receives a sibling's documents or status while the join is open, including when
concurrency limits cause it to launch later. The state reached after the join
receives the normal completed-parallel summary and all successful documents.

## Scheduling, Workspaces, and Join

After materialization, dynamic tasks use the existing parallel execution path:

- tasks are claimed in collection order;
- at most effective `max_concurrency` tasks are active;
- a settled task frees a slot for the next queued task;
- one failed task does not stop queued siblings or cancel running siblings;
- every task has independent attempts, retry delay, timeout, control paths,
  executor references, documents, and final error;
- direct mode retains its existing shared-project-workspace behavior;
- worktree mode creates one child worktree per materialized item ID.

The all-settled join remains engine-calculated. It emits `succeeded` for an
empty collection or when every task succeeded, and `failed` when one or more
tasks exhausted their attempts. Successful documents and failure evidence are
preserved with work-item task provenance.

Unsafe external execution, workflow-limit exhaustion, context or worktree
preparation failure, and join-persistence failure remain engine failures rather
than aggregate `failed` outcomes.

## Recovery and Cancellation

Recovery treats the materialized visit as authoritative. It never re-reads the
producer's `result.json`, re-resolves a newer producer output, or expands the
collection again.

Recovery supports these boundaries without duplicating work:

- output committed but consumer visit not yet created: create the visit and
  materialize from the committed output;
- visit materialized but no task launched: continue from the persisted queue;
- some tasks settled and others queued or running: reconcile running attempts
  and continue the remaining queue;
- all tasks settled but join not committed: calculate and commit the join from
  persisted task records.

Cancellation records queued, running, and settled dynamic tasks using the same
rules as static parallel tasks. Item IDs remain part of attempt identity and
executor provenance.

## Limits and Failure Codes

`max_items` protects total fan-out and durable-state growth. `max_concurrency`
independently protects simultaneous external execution. The design adds no
batch-size or segment concept: bounded concurrency naturally drains the ordered
queue in successive groups.

New stable failures are:

- `structured_outputs_invalid`: the result omits or violates a declared output
  contract, including `max_items`; this is an attempt failure and is retryable.
- `dynamic_source_unavailable`: no committed source output exists when the
  consumer is entered; this is an engine-level terminal failure.
- `dynamic_source_corrupt`: the committed artifact is absent or fails integrity
  verification during materialization; this is an engine-level terminal
  failure.

Existing result, attempt, timeout, global-limit, cancellation, unsafe-execution,
and persistence behavior remains unchanged.

## Observability

The run history adds:

- `structured_output_committed`, containing producer state, visit, output name,
  type, item count, durable path, and hash;
- `dynamic_tasks_materialized`, containing consumer state and visit, source
  provenance, ordered item IDs, and count.

Existing `task_queued`, task-started, attempt, task-settled, join, document, and
transition events use each item's `id` as the dynamic task ID.

Status presentation summarizes a dynamic visit with total, queued, running,
succeeded, failed, and settled counts. History preserves the causal chain from
source output through item ID, attempts, documents, errors, and final join.
Full work-item payloads remain in durable output and task-context artifacts
rather than being copied into ordinary event output.

## Architecture Placement

- `src/ports/project-definitions.ts` owns structured-output definitions, source
  references, and static/dynamic parallel definition unions.
- The filesystem project-definition adapter parses the closed YAML schema,
  resolves effective limits, validates source references, and snapshots the
  effective definition.
- `src/domain/execution/` owns durable structured-output provenance, dynamic
  task bindings, materialized-visit invariants, empty/all-settled join behavior,
  and stable identity rules.
- Execute and recovery use cases coordinate validation, output commit,
  materialization, scheduling, and recovery without duplicating domain rules.
- The run-repository port exposes technology-independent operations for
  validating, staging, reading, and verifying structured outputs and for
  preparing task-specific contexts.
- The filesystem run repository stores immutable JSON output artifacts and
  renders task contexts.
- CLI presenters add dynamic source and progress summaries without introducing
  workflow behavior.

No new architectural layer, external executor capability, template engine, or
background scheduler is introduced.

## Compatibility

This is an additive `version: 1` feature:

- definitions without `produces`, `for_each`, or dynamic `task` fields retain
  their current effective representation and behavior;
- existing static parallel definitions still require a non-empty `tasks` map;
- existing durable snapshots load without migration and cannot acquire dynamic
  behavior from later project-file edits;
- Orca's launch lifecycle and parallel worker result outcomes are unchanged;
- current normal results without declared outputs remain valid.

## Test Strategy

### Definition and snapshot tests

- Accept valid producer and dynamic consumer definitions.
- Apply the default `max_items: 100` and preserve explicit positive overrides.
- Reject unknown producers, unknown outputs, non-`work_items` sources, malformed
  source syntax, invalid limits, missing templates, and mixed static/dynamic
  task forms.
- Preserve dynamic definitions through snapshot creation and load.
- Confirm existing static definitions and durable snapshots remain compatible.

### Result validation tests

- Accept empty, single-item, and maximum-size collections.
- Preserve array order and opaque nested JSON properties.
- Reject missing outputs, undeclared outputs, non-arrays, non-object members,
  missing or invalid IDs, duplicate IDs, and collections over `max_items`.
- Confirm invalid producer attempts retry and never commit outputs.

### Execution tests

- Materialize zero, one, and many tasks with correct provenance.
- Assert zero items produce `succeeded` without calling the executor.
- Assert definition order and effective concurrency bounds.
- Verify every worker receives only its own work item and every retry receives
  byte-equivalent item context.
- Verify one or more exhausted tasks produce aggregate `failed` only after all
  siblings settle.
- Preserve successful documents and task-specific failures at the join.
- Create distinct child worktrees keyed by item ID in worktree mode.

### Cycle and recovery tests

- Resolve the most recent preceding committed producer visit in a cycle.
- Fail deterministically when no committed source is available.
- Resume after output commit, after materialization, during partial execution,
  and before join commit without regenerating tasks or duplicating launches.
- Detect missing or corrupted committed output artifacts.
- Preserve cancellation and uncertain-execution safeguards for dynamic tasks.

### Regression tests

- Run the existing normal-state, static-parallel, retry, timeout, global-limit,
  recovery, cancellation, status/history, context, and worktree suites.

## Acceptance Criteria

The feature is complete when a workflow can produce zero to `max_items`
structured work items, durably materialize exactly one isolated task per unique
item ID, process them sequentially or concurrently through existing policies,
recover without duplicate expansion or execution, and commit the existing
all-settled aggregate transition while all prior workflow definitions continue
to behave unchanged.
