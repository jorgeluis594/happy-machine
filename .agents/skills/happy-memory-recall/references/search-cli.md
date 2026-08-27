# happy-memory Read Contract

Run commands from the Git repository associated with the target project.

## Search

```text
happy-memory search "<query>" [filters]
```

Pass exactly one non-empty query. The default limit is `10`.

For 1–100 independent searches already selected by the agent, send one strict
JSON object to `happy-memory search --input -`:

```json
{"searches":[{"query":"sqlite"},{"query":"worktrees","type":"decision","tags":["git"],"limit":5}]}
```

Each entry accepts `query`, `type`, `tags`, `specific_tags`, `min_importance`,
`min_confidence`, and `limit`; omitted limits default to `10`. Do not combine
the input mode with a positional query or filter flags.

| Flag | Valid value | Semantics |
| --- | --- | --- |
| `--type` | `fact`, `decision`, `constraint`, `preference`, `procedure`, or `lesson` | Match one type |
| `--tag` | Non-empty tag; repeatable | Require every supplied tag |
| `--specific-tags` | Non-empty comma-separated tags | Require every normalized token in canonical tag names |
| `--min-importance` | Integer `1` through `5` | Match values at or above the minimum |
| `--min-confidence` | Integer `1` through `5` | Match values at or above the minimum |
| `--limit` | Integer `1` through `100` | Limit returned results |

Omit unused filters. Run separate searches for alternatives such as multiple types or OR queries.

## Matching and ranking

- Search only active memories in the project resolved from the current Git repository.
- Match the general query against current `title` and `content`; tags,
  attributes, history, and deleted content cannot satisfy a general term.
- Use exact `tags` to require complete canonical normalized names. Use
  `specific_tags` as tokenized canonical-tag constraints combined with AND.
- Give specific tags zero BM25 weight so they restrict candidates without
  changing text relevance.
- Treat whitespace-delimited query terms as literal AND terms. Do not infer synonyms or semantic intent.
- Treat a punctuation-only query as a successful empty result.
- Compare scores only within the same response; each search normalizes its own candidate set.

## Results

A successful search exits with code zero and writes:

```json
{"ok":true,"data":{"ranking_version":1,"results":[...]}}
```

Each result contains `id`, `type`, `title`, `content`, `importance`, `confidence`, `tags`, and `score`. The score contains `final`, `text`, `importance`, and `confidence`.

An empty search is successful:

```json
{"ok":true,"data":{"ranking_version":1,"results":[]}}
```

Batch output contains a summary and one ordered item per entry. Each item has
`index`, `ok`, and either the normal search `data` or a public `error`. Partial
success exits zero and successful items must be preserved. Invalid JSON,
unknown fields, trailing content, batches outside 1–100, storage-open failures,
and project-resolution failures fail the whole command.

## Tag vocabulary

```text
happy-memory tags list
happy-memory tags search "<query>"
```

Use `tags search` with a non-empty literal substring. Both commands return `data.tags`; every tag contains `id`, `name`, `normalized_name`, `description`, `created_at`, `updated_at`, and `active_memory_count`. Vocabulary lookup does not select a tag.

## Failures

A failed command exits nonzero, writes JSON to stderr, and uses:

```json
{"ok":false,"error":{"code":"<code>","message":"<message>","details":{}}}
```

Handle these stable codes:

| Code | Meaning |
| --- | --- |
| `GIT_REPOSITORY_NOT_FOUND` | The current directory is not a Git repository |
| `PROJECT_NOT_INITIALIZED` | The repository has no usable project identity |
| `VALIDATION_ERROR` | The query, filters, or arguments are invalid |
| `STORE_BUSY` | Storage remained busy after bounded retries |
| `STORE_ERROR` | Storage or an internal read failed |

Do not initialize, mutate, repair, or switch projects after a read failure. A missing executable is a local execution failure, not a CLI JSON error.
