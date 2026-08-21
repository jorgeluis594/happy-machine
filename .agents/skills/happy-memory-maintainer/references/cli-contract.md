# happy-memory Maintenance Contract

Run commands from the Git repository associated with the target project. Accept command success only when the process exits with code zero and stdout contains `ok: true`; preserve `code`, `message`, and `details` from failures written to stderr.

## Find the target

Search related active memories:

```text
happy-memory search "<query>" [filters] --limit 10
```

Use one non-empty textual query. Search matches current titles and content, joins terms with AND, and does not infer synonyms. Add `--type`, repeated `--tag`, `--specific-tags`, `--min-importance`, or `--min-confidence` only when the maintenance case requires them.

Search results do not contain the current version. Before updating or deleting, run:

```text
happy-memory get <memory-id>
```

Use the returned version as `expected_version`.

## Mutate through batch

Use batch as the only mutation path, including for one operation:

```text
happy-memory batch --input -
```

Send one strict JSON object with 1 to 100 ordered operations:

```json
{"operations":[...]}
```

Do not target the same existing memory more than once in one batch.

### Create

```json
{"operation":"create","input":{"type":"fact","title":"Atomic title","content":"Complete content","importance":4,"confidence":5,"attributes":null,"tags":["keyword"]}}
```

Use one of `fact`, `decision`, `constraint`, `preference`, `procedure`, or `lesson`. Require a non-empty title and content plus importance and confidence from `1` through `5`.

`attributes` may be an object or null. `tags` may contain strings or objects with `name` and optional `description`. `agent` is optional and accepts a non-empty `name` plus optional `role`. Do not supply IDs, versions, hashes, timestamps, project identity, or worktree provenance.

### Update

```json
{"operation":"update","memory_id":"<memory-id>","expected_version":2,"input":{"title":"Revised title"}}
```

Send only changed fields. An absent field preserves its value; `attributes: null` removes attributes; `tags: []` removes all tags; any present `tags` replaces the complete tag set. An effective update increments the version; a no-op does not.

### Delete

```json
{"operation":"delete","memory_id":"<memory-id>","expected_version":2}
```

Deletion is logical and preserves revision history.

## Verify batch results

Operations run in input order and are independently atomic; a failed item does not roll back successful items. The response envelope may have `ok: true` while individual results fail.

Require a successful envelope, then inspect every result by `index`, `operation`, and item `ok`. Preserve item errors. Put operations that depend on earlier results in a later batch and run them only after their prerequisites succeed.

## Find tags

```text
happy-memory tags search "<query>" --limit 10
```

Use a non-empty specific query. Do not use `tags list` during maintenance.

## Handle errors

- `VERSION_CONFLICT`: retrieve current state, reassess, and retry at most once in a later batch.
- `DUPLICATE_MEMORY`: inspect the existing active memory and choose update or no change.
- `VALIDATION_ERROR`: correct one generated command only when this contract identifies the defect; otherwise stop.
- `MEMORY_NOT_FOUND`: stop the target operation without substituting another ID.
- `GIT_REPOSITORY_NOT_FOUND` or `PROJECT_NOT_INITIALIZED`: stop without initialization or repair.
- `STORE_BUSY` or `STORE_ERROR`: preserve the failure and stop dependent operations.

Never convert an error into an empty result. A missing executable is a local execution failure, not a CLI JSON error.
