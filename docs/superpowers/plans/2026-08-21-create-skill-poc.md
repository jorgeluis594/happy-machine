# Create Skill Proof-of-Concept Implementation Tasks

**Status:** Ready for implementation

**Date:** 2026-08-21

## Sources of truth

- [Product design](../specs/2026-08-20-create-skill-poc-product-design.md)
- [Technical design](../specs/2026-08-21-create-skill-poc-technical-design.md)
- [Happy Machine architecture](../../ARCHITECTURE.md)

The product design is the functional source of truth. The technical design owns
the implementation boundaries and its explicit clarifications override less
specific wording in the product design.

## Objective

Implement `happy-machine create-skill --agent=codex` as a standalone,
testable flow that captures a user-demonstrated workflow through Codex
app-server, prepares isolated Markdown context, and starts a fresh Codex skill
creation session with exactly one initial prompt.

The tasks below are units of technical work determined by executable outcomes
and real dependencies. A task is complete only when its result can be
exercised and its stated validation passes.

## Planning rules

- Keep every task independently testable after its declared dependencies are
  complete.
- Merge each completed task without breaking the existing test suite or
  typecheck.
- Parallelize only tasks whose dependency lists are satisfied and whose main
  files do not overlap materially.
- Use fakes for all automated tests. Automated validation must not require a
  Codex account, network access, or a model call.
- Assert semantic prompt requirements instead of snapshotting complete prompt
  wording.
- Do not introduce `RunRecord`, task-graph, worktree, durable-recovery, or
  Domain state for this feature.
- Keep vendor DTOs, JSON-RPC, processes, sockets, paths, and permissions inside
  Infrastructure.

For Tasks 1-17, the minimum validation is the task's focused test command plus
`npm run typecheck`. If shared code changes while work proceeds in parallel,
also rerun the focused tests of direct dependents before considering the task
complete.

## Overall scope

### In scope

- Exact CLI contract and interactive prompts.
- Technology-independent ports and application orchestration.
- Three isolated Codex sessions backed by one app-server process.
- Conversation capture, Markdown serialization, analysis, and generation
  handoff.
- Private temporary storage, process-wide exclusion, cancellation, failure
  reporting, and cleanup.
- Deterministic automated tests and one manual smoke test against the baseline
  Codex version.

### Outside scope

- Agents other than Codex.
- Hooks or terminal-output scraping.
- Concurrent captures, capture history, retry, resume, or recovery.
- Integration with the normal Happy Machine workflow state machine.
- Evaluation, repair, discovery, or scoring of the generated skill.
- Choosing the skill name, structure, scope, or destination.
- Follow-up prompts or supervision after generation starts.
- Speculative multi-vendor abstractions beyond the approved ports.

## Relevant implementation data

| Concern | Required value or behavior |
| --- | --- |
| Runtime | Node.js `>=22.18.0`; TypeScript ESM with `NodeNext` resolution |
| Test runner | Vitest; tests live under `tests/**/*.test.ts` |
| Codex baseline | Codex CLI `0.148.0`, with capability checks taking precedence over version checks |
| Agent value | Required `--agent=codex`; no default and no duplicate flag |
| Terminal | Both stdin and stdout must be TTYs |
| Sessions | Demonstration: managed; analysis: managed or ephemeral; generation: persistent |
| Session count | Three distinct sessions; only demonstration and generation open TUIs |
| Analysis turn | Read-only filesystem, network disabled, structured non-empty Markdown result |
| Generation | Exactly one initial prompt; no follow-up or result inspection |
| Workspace | Random OS-temporary directory, mode `0700` |
| Capture files | `.capture-owner.json`, `demonstration.md`, and `skill-context.md`, mode `0600` |
| Lock | One stable process-wide `create-skill` lock with live/stale owner handling |
| Raw-data boundary | Remove `demonstration.md` and the demonstration thread before generation starts |
| Exit codes | `0` completed or declined consent; `2` canceled after recording starts; `1` invalid input or failure |
| Full validation | `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` |

## Dependency and parallelization map

```text
Wave 0
  T01 Contracts and errors              T04 Deterministic fake Codex
       |                                      |
       +----------------------+---------------+
                              |
Wave 1 (parallel)
  T02 Serializer   T03 Prompts   T05 Capture store   T06 Lock
  T11 JSON-RPC     T12 Processes T13 Mapper
       |               |             |
       +---------------+-------------+
                       |
Wave 2 (parallel)
  T07 Capture stage   T08 Analysis stage   T09 Generation stage
  T14 Codex sessions adapter
          |                |                    |
          +----------------+--------------------+
                           |
Wave 3
  T10 CreateSkill orchestration (can overlap remaining T14 work)

Wave 4
  T15 CLI (can overlap remaining T14 work once T10 is complete)
  T16 Composition and successful end-to-end flow
  T17 Failure, cancellation, privacy, and cleanup hardening
  T18 Full validation and manual smoke test
```

The diagram shows scheduling waves, not mandatory ownership boundaries. Within
Wave 1, Tasks 11 and 12 depend on Task 4 as well as Task 1. Tasks 7-9 depend on
their corresponding pure helpers. Exact dependencies are stated per task.

## Task 1: Define the technology-independent contracts and error model

**Depends on:** None.

**Can run in parallel with:** Task 4.

### Scope

- Add `AgentSessions`, `SkillCaptureStore`, and
  `ExclusiveOperationLock` under `src/ports/`.
- Define the neutral conversation, session, artifact, lease, interactive-exit,
  turn-request, and turn-result types required by the technical design.
- Add stable create-skill error codes and stages beside the use case, including
  preservation of an internal cause without exposing vendor types.
- Provide runtime behavior for constructing, identifying, and safely rendering
  create-skill errors so the contracts have focused executable tests in
  addition to typechecking.

### Outside scope

- Concrete filesystem, process, JSON-RPC, or Codex behavior.
- The `CreateSkill` orchestration and CLI messages.
- A new Domain module.

### Acceptance criteria

- Application-facing contracts contain no Codex, JSON-RPC, filesystem, socket,
  or child-process types.
- `AgentConversation` represents ordered supported items and an explicit
  neutral `other` item.
- Session retention distinguishes `managed` from `persistent`.
- All approved error codes and stages are representable.
- Errors preserve their original cause for diagnosis while exposing a stable
  application code and stage.
- TypeScript compiles consumers against the contracts without importing
  Infrastructure.

### Relevant data

- Likely files: `src/ports/agent-sessions.ts`,
  `src/ports/skill-capture-store.ts`,
  `src/ports/exclusive-operation-lock.ts`, and
  `src/application/use-cases/create-skill/create-skill-errors.ts`.
- Focused test: `tests/create-skill-contracts.test.ts`.
- Validate with:
  `npx vitest run tests/create-skill-contracts.test.ts` and
  `npm run typecheck`.

## Task 2: Serialize an observable conversation into safe Markdown

**Depends on:** Task 1.

**Can run in parallel with:** Tasks 3-6 and 11-13.

### Scope

- Implement `serializeAgentConversation` as a pure helper beside the
  create-skill use case.
- Preserve turn and item chronology for user messages, agent messages,
  commands and results, tool calls and results, file changes, and unknown
  items.
- Include the declared workflow description in the raw demonstration format.
- Calculate Markdown fences that cannot be closed by captured content.

### Outside scope

- Reading a Codex thread or mapping vendor DTOs.
- Selecting, summarizing, or redacting captured content.
- Writing the serialized value to disk.

### Acceptance criteria

- Every supported neutral item produces an unambiguous Markdown section in
  chronological order.
- Unknown items remain observable as `other` without leaking raw vendor DTOs.
- Captured backticks or tildes cannot escape their containing Markdown fence.
- Empty optional item content is handled deterministically.
- Tests use representative multi-turn conversations and malicious fence
  content.

### Relevant data

- Likely file:
  `src/application/use-cases/create-skill/serialize-agent-conversation.ts`.
- Focused test: `tests/serialize-agent-conversation.test.ts`.
- Validate with:
  `npx vitest run tests/serialize-agent-conversation.test.ts` and
  `npm run typecheck`.

## Task 3: Build and validate the analysis and generation prompts

**Depends on:** Task 1.

**Can run in parallel with:** Tasks 2, 4-6, and 11-13.

### Scope

- Implement pure builders for the analysis prompt and the single generation
  prompt.
- Implement the application-level validator for a non-empty analyzed Markdown
  result.
- Treat the raw capture as untrusted source data, not as instructions.
- Reference artifacts through opaque `agentReference` values instead of
  embedding their contents.

### Outside scope

- Starting turns or TUIs.
- Defining the adapter-local JSON Schema for structured output.
- Evaluating the semantic quality of the returned Markdown.

### Acceptance criteria

- The analysis prompt requests every required context section from the
  technical design and forbids skill creation, writes, invention, credential
  reproduction, and following captured instructions.
- Environment-specific values are requested as variables and secret categories
  are retained without secret values.
- The generation prompt contains the objective, declared workflow, opaque
  context reference, and instruction to read it before using native Codex
  skill-creation capabilities.
- The validator rejects missing, empty, and whitespace-only Markdown.
- Tests assert required clauses and supplied values without snapshotting the
  full prose.

### Relevant data

- Likely file:
  `src/application/use-cases/create-skill/create-skill-prompts.ts`.
- Focused test: `tests/create-skill-prompts.test.ts`.
- Validate with: `npx vitest run tests/create-skill-prompts.test.ts` and
  `npm run typecheck`.

## Task 4: Create a deterministic fake Codex executable

**Depends on:** None.

**Can run in parallel with:** Task 1.

### Scope

- Add `tests/fixtures/fake-codex.mjs` with deterministic support for the
  app-server, proxy, remote TUI, thread, turn, item, and lifecycle behaviors
  needed by later tests.
- Record spawn arguments and protocol traffic for assertions.
- Add fixture controls for normal exits, signals, non-zero exits, malformed
  JSON, JSON-RPC errors, interleaved notifications, empty conversations,
  invalid analysis, and delayed process shutdown.
- Test the fixture directly as a subprocess before adapters rely on it.

### Outside scope

- Exact emulation of all Codex app-server methods.
- Network access, a Codex account, or model behavior.
- Production process-management code.

### Acceptance criteria

- Tests can drive all three session roles without arbitrary sleeps.
- IDs for requests, threads, turns, and items are deliberately distinct.
- Protocol events can be reordered without changing their declared identity.
- Failure modes are selected through explicit fixture inputs and leave an
  inspectable call log.
- The fixture test exits deterministically and cleans up its child processes.

### Relevant data

- Likely files: `tests/fixtures/fake-codex.mjs` and
  `tests/fake-codex.test.ts`.
- The fixture should follow the controlled-executable pattern already used by
  `tests/fixtures/fake-orca.mjs` without sharing Orca-specific code.
- Validate with: `npx vitest run tests/fake-codex.test.ts` and
  `npm run typecheck`.

## Task 5: Implement the private filesystem capture store

**Depends on:** Task 1.

**Can run in parallel with:** Tasks 2-4 and 6-13.

### Scope

- Implement `FilesystemSkillCaptureStore` below the operating-system temporary
  directory.
- Create private workspaces and atomically write the raw demonstration and
  analyzed context.
- Return opaque agent-readable references.
- Implement idempotent artifact removal, workspace cleanup, and validated
  abandoned-workspace cleanup.
- Preserve the private workspace path when cleanup fails so the presenter can
  report it for manual removal.

### Outside scope

- Process-wide locking.
- Codex thread deletion.
- Capture history, retry data, or recovery.

### Acceptance criteria

- Workspace mode is `0700`; ownership metadata and regular artifacts are
  `0600` on the supported Unix runtime.
- Writes use a temporary sibling and atomic rename.
- Abandoned cleanup requires the exact directory prefix, a valid marker,
  current ownership, and a dead PID.
- A live owner, malformed marker, unrelated directory, or symlink is never
  removed.
- Cleanup is idempotent and reports incomplete removal accurately.
- No captured content is written to diagnostic output.

### Relevant data

- Workspace files: `.capture-owner.json`, `codex-app-server.sock`,
  `demonstration.md`, and `skill-context.md`.
- Likely file:
  `src/infrastructure/outbound/skill-capture-store/filesystem/filesystem-skill-capture-store.ts`.
- Focused test: `tests/filesystem-skill-capture-store.test.ts`.
- Validate with:
  `npx vitest run tests/filesystem-skill-capture-store.test.ts` and
  `npm run typecheck`.

## Task 6: Implement exclusive create-skill ownership

**Depends on:** Task 1.

**Can run in parallel with:** Tasks 2-5 and 7-14.

### Scope

- Implement `FilesystemExclusiveOperationLock` with atomic acquisition for the
  stable `create-skill` operation name.
- Store sufficient owner metadata to distinguish a live owner from a stale
  owner.
- Safely replace only a verified stale lock and release only the caller's own
  lease.

### Outside scope

- General distributed locking.
- More than one operation name.
- Workspace cleanup or capture recovery.

### Acceptance criteria

- Two simultaneous acquisition attempts cannot both succeed.
- A live owner maps to the technology-independent
  `capture_already_active` behavior.
- A stale owner can be replaced after PID verification.
- A previous lease cannot release a newer owner's lock.
- Release is idempotent and leaves unrelated files untouched.

### Relevant data

- Likely file:
  `src/infrastructure/outbound/exclusive-operation-lock/filesystem/filesystem-exclusive-operation-lock.ts`.
- Focused test: `tests/filesystem-exclusive-operation-lock.test.ts`.
- Validate with:
  `npx vitest run tests/filesystem-exclusive-operation-lock.test.ts` and
  `npm run typecheck`.

## Task 7: Implement the demonstration capture stage

**Depends on:** Tasks 1 and 2.

**Can run in parallel with:** Tasks 8, 9, and 11-14.

### Scope

- Implement `CaptureDemonstration` using only `AgentSessions`,
  `SkillCaptureStore`, and the serializer.
- Create a fresh managed session and launch its TUI without an initial prompt.
- Classify TUI exit, read the complete neutral conversation, reject an empty
  demonstration, serialize it, and persist the raw artifact.

### Outside scope

- Analysis, context selection, or skill generation.
- Codex DTO mapping and process implementation.
- Overall lock or final cleanup ownership.

### Acceptance criteria

- A normal TUI exit proceeds regardless of the command the user used to exit.
- A signal or non-zero exit never produces a successful capture.
- The interactive request has no initial prompt.
- An empty observable conversation returns `demonstration_empty`.
- The persisted Markdown matches the serializer output and is written once.
- Cancellation is propagated to the session port.

### Relevant data

- Likely file:
  `src/application/use-cases/create-skill/capture-demonstration.ts`.
- Focused test: `tests/capture-demonstration.test.ts`.
- Validate with: `npx vitest run tests/capture-demonstration.test.ts` and
  `npm run typecheck`.

## Task 8: Implement isolated demonstration analysis

**Depends on:** Tasks 1 and 3.

**Can run in parallel with:** Tasks 7, 9, and 11-14.

### Scope

- Implement `AnalyzeDemonstration` with a fresh non-interactive analysis
  session.
- Submit one analysis turn using the raw artifact as a readable resource.
- Validate and persist the resulting Markdown.
- Dispose the analysis session and remove the raw artifact and demonstration
  session at the approved privacy boundary.

### Outside scope

- Opening a TUI or creating a skill.
- Semantic scoring or retry of analysis.
- Adapter-local structured-output JSON Schema.

### Acceptance criteria

- The analysis session is distinct from the demonstration session.
- The turn is read-only, network-disabled, expects Markdown, and names only the
  required readable artifact.
- Interrupted, failed, missing, empty, or whitespace-only output prevents
  generation.
- Valid Markdown is persisted exactly once.
- Raw demonstration data and the demonstration session are removed before the
  stage reports success.
- Cleanup failure is surfaced without claiming that deletion completed.

### Relevant data

- Likely file:
  `src/application/use-cases/create-skill/analyze-demonstration.ts`.
- Focused test: `tests/analyze-demonstration.test.ts`.
- Validate with: `npx vitest run tests/analyze-demonstration.test.ts` and
  `npm run typecheck`.

## Task 9: Implement the generation launch stage

**Depends on:** Tasks 1 and 3.

**Can run in parallel with:** Tasks 7, 8, and 11-14.

### Scope

- Implement `LaunchSkillGeneration` with a fresh persistent session.
- Build and submit the one allowed initial prompt when launching the generation
  TUI.
- Wait only for TUI process lifecycle and return the classified outcome.

### Outside scope

- Follow-up turns, result reading, skill discovery, evaluation, or repair.
- Deleting the persistent generation thread after its TUI starts.
- Overall temporary-workspace cleanup.

### Acceptance criteria

- The generation session uses `retention: "persistent"` and differs from the
  other session IDs.
- The TUI receives exactly one initial prompt and the context artifact as a
  readable resource.
- No non-interactive generation turn or follow-up port call is made.
- Failure before TUI startup disposes the incomplete session.
- Once the TUI starts, its thread is retained even if the user later interrupts
  the TUI.

### Relevant data

- Likely file:
  `src/application/use-cases/create-skill/launch-skill-generation.ts`.
- Focused test: `tests/launch-skill-generation.test.ts`.
- Validate with:
  `npx vitest run tests/launch-skill-generation.test.ts` and
  `npm run typecheck`.

## Task 10: Orchestrate the complete CreateSkill use case with fakes

**Depends on:** Tasks 1 and 7-9.

**Can run in parallel with:** Tasks 5, 6, and 11-14 after Tasks 7-9 are
complete.

### Scope

- Implement the public `CreateSkill` use case and its request/result contract.
- Coordinate exclusive ownership, compatibility, consent, abandoned cleanup,
  runtime lifecycle, the three stages, cancellation, and final cleanup.
- Preserve the primary operational error while collecting independent cleanup
  failures.
- Express all orchestration tests with fake ports and stage collaborators.

### Outside scope

- CLI parsing or presentation.
- Concrete Codex, filesystem, socket, and process behavior.
- Retry, resume, or supervision of the generated skill.

### Acceptance criteria

- Static compatibility runs after lock acquisition and before recording
  consent; declining consent creates no capture workspace or runtime.
- Demonstration, analysis, and generation occur in the approved order.
- An earlier failure prevents every later stage.
- The use case returns only the approved completed/canceled outcomes and stable
  errors.
- One idempotent `finally` path attempts every independent cleanup step and
  releases the lease last.
- Three stage session IDs cannot be accidentally reused.
- Tests cover success, consent decline, every stage failure, abort signals,
  primary-plus-cleanup failure, and cleanup-only failure.

### Relevant data

- Likely file:
  `src/application/use-cases/create-skill/create-skill.ts`.
- Focused test: `tests/create-skill.test.ts`.
- Validate with: `npx vitest run tests/create-skill.test.ts` and
  `npm run typecheck`.

## Task 11: Implement the Codex JSON-RPC control client

**Depends on:** Tasks 1 and 4.

**Can run in parallel with:** Tasks 2, 3, 5-9, 12, and 13.

### Scope

- Implement initialization, monotonically unique request IDs, response
  correlation, notifications, server-initiated requests, and protocol-error
  handling over the proxy JSONL stream.
- Match turn completion by both thread and turn identity.
- Ignore unrelated notification methods while rejecting malformed messages
  required by an active operation.
- Bound shutdown and reject unresolved requests when transport ends.

### Outside scope

- Child-process spawning and socket readiness.
- Mapping Codex conversations into neutral application types.
- Session retention policy or application orchestration.

### Acceptance criteria

- `initialize` response precedes `initialized`, and no other request is sent
  before the handshake completes.
- Responses resolve by request ID even when notifications and responses are
  interleaved or reordered.
- Turn completion for another thread or turn cannot complete the active call.
- Malformed required responses, JSON-RPC errors, unexpected EOF, and aborts
  reject with adapter-local errors and no hanging promises.
- Tests use the deterministic fake transport without arbitrary delays.

### Relevant data

- Likely file:
  `src/infrastructure/outbound/agent-sessions/codex-app-server/codex-json-rpc-client.ts`.
- Focused test: `tests/codex-json-rpc-client.test.ts`.
- Validate with: `npx vitest run tests/codex-json-rpc-client.test.ts` and
  `npm run typecheck`.

## Task 12: Implement Codex process and terminal lifecycle management

**Depends on:** Tasks 1 and 4.

**Can run in parallel with:** Tasks 2, 3, 5-9, 11, and 13.

### Scope

- Implement app-server, proxy, and remote-TUI process spawning without a
  shell.
- Implement static compatibility checks for the executable and required CLI
  argument forms.
- Manage private Unix-socket readiness, inherited TTY streams, aborts, normal
  exits, signals, non-zero exits, and bounded shutdown.
- Retain safe diagnostic causes without logging prompts or captured content.

### Outside scope

- JSON-RPC message semantics.
- Conversation mapping and session policy.
- Cross-platform transports other than the approved Unix socket.

### Acceptance criteria

- Every command argument is passed as a separate spawn argument with
  `shell: false`.
- Compatibility reports missing or unsupported commands before demonstration
  starts.
- Socket readiness cannot be confused with a stale pre-existing socket.
- TUI stdin/stdout/stderr are inherited and exit reasons map to normal,
  interrupted, or failed.
- Abort and shutdown terminate children in a bounded order and reap them.
- Spawn tests assert that workflow text and artifact references are never shell
  interpolated.

### Relevant data

- Process topology: `codex app-server --listen unix://<socket>`,
  `codex app-server proxy --sock <socket>`, and
  `codex resume --remote unix://<socket> <thread-id> [prompt]`.
- Likely file:
  `src/infrastructure/outbound/agent-sessions/codex-app-server/codex-process-runtime.ts`.
- Focused test: `tests/codex-process-runtime.test.ts`.
- Validate with: `npx vitest run tests/codex-process-runtime.test.ts` and
  `npm run typecheck`.

## Task 13: Map Codex conversations without leaking vendor data

**Depends on:** Task 1.

**Can run in parallel with:** Tasks 2-12.

### Scope

- Implement the adapter-local mapping from Codex thread, turn, and observable
  item shapes to `AgentConversation`.
- Preserve chronology and the supported neutral item categories.
- Map new or unsupported item variants to `other` using safe observable text
  and metadata only.
- Reject malformed data required to establish turn or item identity.

### Outside scope

- Fetching a thread through JSON-RPC.
- Markdown serialization.
- Private reasoning not exposed by app-server.

### Acceptance criteria

- Representative user, agent, command, tool, and file-change DTOs map to the
  expected neutral items in order.
- Unknown variants do not fail the complete capture and do not cross the port
  boundary as raw objects.
- Missing required identity or chronology data produces an adapter-local
  protocol error.
- Mapping is deterministic and has no filesystem or process side effects.

### Relevant data

- Likely file:
  `src/infrastructure/outbound/agent-sessions/codex-app-server/codex-conversation-mapper.ts`.
- Focused test: `tests/codex-conversation-mapper.test.ts`.
- Validate with:
  `npx vitest run tests/codex-conversation-mapper.test.ts` and
  `npm run typecheck`.

## Task 14: Assemble the Codex app-server session adapter

**Depends on:** Tasks 1, 4, and 11-13.

**Can run in parallel with:** Task 10 once their respective dependencies are
complete, and Task 15 after Task 10 is complete.

### Scope

- Implement `CodexAppServerSessions` as the `AgentSessions` adapter using the
  JSON-RPC client, process runtime, and conversation mapper.
- Map neutral sessions to Codex threads with managed, ephemeral-when-supported,
  and persistent lifecycles.
- Implement dynamic capability checks, thread create/read/delete, interactive
  resume, one-turn structured analysis, and adapter error translation.
- Define and enforce the adapter-local JSON Schema containing one non-empty
  `markdown` string.

### Outside scope

- Application stage order or consent.
- Filesystem capture and locking.
- Fallback hooks or terminal scraping.

### Acceptance criteria

- One adapter instance owns one app-server runtime for the complete flow.
- Session operations never expose JSON-RPC, Codex DTO, socket, or subprocess
  values through the port.
- `readConversation` includes turns and returns the neutral mapper result.
- The analysis call waits for the matching `turn/completed` and extracts only
  valid structured Markdown.
- Managed sessions are deleted, persistent generation sessions are retained,
  and an unsupported ephemeral lifecycle falls back only to explicit managed
  deletion.
- Vendor failures map to the approved stable application-facing capability
  failures without capture content in messages.

### Relevant data

- Likely files:
  `src/infrastructure/outbound/agent-sessions/codex-app-server/codex-app-server-sessions.ts`
  and `codex-app-server-errors.ts`.
- Focused test: `tests/codex-app-server-sessions.test.ts`.
- Validate with:
  `npx vitest run tests/codex-app-server-sessions.test.ts` and
  `npm run typecheck`.

## Task 15: Add the standalone create-skill CLI interaction

**Depends on:** Task 10.

**Can run in parallel with:** Task 14.

### Scope

- Add a focused `create-skill-command.ts` that parses the exact command,
  verifies TTYs, collects a non-empty workflow description, and invokes one
  `CreateSkill` use case.
- Add `create-skill-presenter.ts` for disclosure, consent, outcomes, stable
  errors, cleanup status, and exit codes.
- Route the command from `cli.ts` and document it in global and command help.
- Keep input/output dependencies injectable for deterministic tests.

### Outside scope

- Capture stage orchestration inside `cli.ts`.
- A default agent or support for non-Codex agents.
- Debug transcript output or display of captured content.

### Acceptance criteria

- Only the exact required `--agent=codex` form is accepted; missing,
  duplicate, unsupported, or additional arguments fail before the use case.
- Both stdin and stdout must be interactive.
- Empty or whitespace-only workflow descriptions are rejected.
- Declining the explicit recording disclosure returns exit code `0` without
  starting capture.
- Completed, post-consent canceled, and failed outcomes map to `0`, `2`, and
  `1` respectively.
- Failure text states whether temporary cleanup completed and identifies a
  remaining private workspace only when cleanup is incomplete.
- All help forms show the exact command contract and cause no side effects.

### Relevant data

- Likely files: `src/infrastructure/inbound/cli/create-skill-command.ts`,
  `create-skill-presenter.ts`, `cli.ts`, and `help-presenter.ts`.
- Focused tests: `tests/create-skill-cli.test.ts` and
  `tests/cli-help.test.ts`.
- Validate with:
  `npx vitest run tests/create-skill-cli.test.ts tests/cli-help.test.ts` and
  `npm run typecheck`.

## Task 16: Wire the feature and prove the successful end-to-end flow

**Depends on:** Tasks 5, 6, 10, 14, and 15.

**Can run in parallel with:** None; this is the first convergence task.

### Scope

- Construct the adapters, stage collaborators, `CreateSkill`, presenter, and
  CLI command in `composition-root.ts`.
- Pass process, filesystem, current-directory, signal, and terminal
  dependencies explicitly.
- Add a full CLI test through the deterministic fake Codex executable for the
  successful path.
- Keep `main.ts` unchanged unless a demonstrated entry-point defect requires a
  minimal correction.

### Outside scope

- Real model calls or assertions about generated skill quality.
- Failure-matrix hardening covered by Task 17.
- New global dependency containers or service locators.

### Acceptance criteria

- The CLI action invokes exactly one public application use case.
- The fake observes two TUI launches, one internal analysis turn, and three
  distinct sessions.
- The demonstration TUI receives no prompt.
- `demonstration.md` and its managed thread are removed before generation is
  launched.
- The generation TUI receives exactly one prompt referencing
  `skill-context.md`.
- The generation thread remains persistent and all Happy Machine temporary
  artifacts are removed after the TUI exits.
- Existing commands and tests continue to work unchanged.

### Relevant data

- Likely files: `src/composition-root.ts` and
  `tests/create-skill-e2e.test.ts`.
- Focused validation:
  `npx vitest run tests/create-skill-e2e.test.ts tests/cli-help.test.ts` and
  `npm run typecheck`.

## Task 17: Harden failure, cancellation, privacy, and cleanup behavior

**Depends on:** Task 16.

**Can run in parallel with:** None; it intentionally exercises all integrated
components.

### Scope

- Exercise and correct every terminal path across the real composition using
  fake Codex failure controls and real temporary filesystem adapters.
- Cover SIGINT/SIGHUP-equivalent aborts, runtime startup, demonstration,
  analysis, generation startup, generation interruption, process shutdown,
  artifact removal, thread disposal, and lease release.
- Prove primary-error preservation with attached cleanup failures.
- Prove a later invocation removes only safely identifiable abandoned data.
- Audit logs and presented errors for capture-content leakage.

### Outside scope

- Retry or resume after failure.
- Guarantees after `SIGKILL`, crashes, or power loss beyond next-run abandoned
  cleanup.
- Retention changes to the ordinary generation conversation.

### Acceptance criteria

- No pre-generation failure or cancellation starts generation.
- Every recoverable terminal path attempts all independent cleanup actions.
- A primary failure remains primary when cleanup also fails.
- Incomplete cleanup is reported truthfully with the private workspace path;
  successful cleanup never reports that path.
- The generation thread is deleted if TUI startup fails but retained after TUI
  startup, including later interruption.
- A stale workspace and lock are removed only after all owner validations pass.
- Captured conversation, prompts, command output, and tool output do not appear
  in diagnostics or user-facing errors.
- A new run is required after any failed or interrupted attempt.

### Relevant data

- Focused tests:
  `tests/create-skill-failures.test.ts` and
  `tests/create-skill-e2e.test.ts`.
- Validate with:
  `npx vitest run tests/create-skill-failures.test.ts tests/create-skill-e2e.test.ts`
  and `npm run typecheck`.

## Task 18: Run release validation and the real Codex smoke test

**Depends on:** Task 17.

**Can run in parallel with:** None.

### Scope

- Run all automated quality gates from a clean process environment.
- Inspect the final source dependency direction and diff for unrelated changes.
- Execute the manual smoke scenario with Codex CLI `0.148.0` or record the
  exact installed version and capability result when a newer compatible
  version is used.
- Record any user-facing setup or compatibility note required by the observed
  behavior in the existing documentation.

### Outside scope

- Changing acceptance criteria to accommodate a failing smoke test.
- Evaluating the quality of the skill Codex creates.
- Publishing a package or release.

### Acceptance criteria

- `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` all pass.
- No Application or Port module imports Infrastructure or vendor-specific
  types.
- Both TUIs occupy the initiating terminal tab and the demonstration receives
  no injected task.
- Normal demonstration exit triggers analysis and then generation with the
  prompt already running.
- Codex can read the analyzed context and continue its native skill-creation
  flow.
- No capture workspace, raw demonstration, managed demonstration thread, or
  process-wide lock remains afterward.
- The test record explicitly distinguishes Happy Machine temporary-data
  deletion from normal Codex generation-thread retention.

### Relevant data

- Automated commands:
  `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
- Manual command: `happy-machine create-skill --agent=codex`.
- Manual evidence should record Codex version, compatibility outcome, observed
  process/session sequence, cleanup result, and any deviation.

## Incremental completion checkpoints

1. **After Tasks 1-4:** contracts, pure behavior, and deterministic external
   simulation are executable; no production side effect exists yet.
2. **After Tasks 5-9:** storage, exclusion, and each application stage are
   independently proven with fakes.
3. **After Tasks 10-15:** the public use case, every adapter boundary, and the
   CLI are independently proven and can converge without requiring a real
   account.
4. **After Task 16:** the complete successful user journey is executable
   end-to-end with the fake Codex process.
5. **After Task 17:** cancellation, failure, privacy, and cleanup guarantees are
   executable across the integrated system.
6. **After Task 18:** automated and real-runtime evidence satisfies the proof
   of concept acceptance criteria.

## Final traceability checklist

- Product consent and workflow declaration: Task 15.
- Exclusive operation ownership: Tasks 6 and 10.
- Demonstration without injected prompt: Tasks 7 and 16.
- App-server capture without hooks or scraping: Tasks 11-14 and 16.
- Isolated non-interactive analysis: Tasks 3, 8, 14, and 16.
- Raw-data deletion before generation: Tasks 5, 8, 16, and 17.
- Fresh generation session with one prompt: Tasks 3, 9, 14, and 16.
- No skill evaluation or follow-up supervision: Tasks 9 and 16.
- Cancellation, failure, cleanup, and truthful reporting: Tasks 5, 6, 10,
  15, and 17.
- Automated validation without a real Codex account: Tasks 4 and 16-17.
- Real terminal and baseline compatibility behavior: Task 18.
