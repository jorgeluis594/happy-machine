# Create Skill Proof-of-Concept Technical Design

**Status:** Approved for implementation planning

**Date:** 2026-08-21

## References

- [Create Skill Proof-of-Concept Product Design](./2026-08-20-create-skill-poc-product-design.md) is the functional source of truth for the proof of concept.
- [Happy Machine Architecture](../../ARCHITECTURE.md) defines the mandatory layers, dependency direction, and file-placement rules.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server) defines the current thread, turn, item, transport, and remote-TUI APIs used by the integration.

This document translates the approved product behavior into Happy Machine's architecture. Where the design review clarified the product document, the explicit clarifications in this document apply to the implementation:

- Any normal exit from the demonstration TUI is accepted; Happy Machine does not attempt to distinguish `/exit` from another normal Codex exit command.
- The product's two Codex sessions are the two user-visible TUI sessions. An additional non-interactive analysis thread is an internal context-preparation operation.
- The analysis prompt is not the generation prompt. Happy Machine still submits exactly one generation prompt and sends no follow-up prompts to the generation thread.

## Objective

Add `happy-machine create-skill --agent=codex` as a standalone CLI operation that:

1. obtains the workflow description and explicit recording consent;
2. lets the user demonstrate the workflow in a fresh Codex TUI;
3. captures the observable Codex conversation;
4. uses an isolated Codex thread to distill the capture into reusable Markdown context; and
5. opens another fresh Codex TUI with one initial prompt that delegates skill creation to Codex.

Happy Machine coordinates capture, isolation, handoff, process lifecycle, and cleanup. It does not author, evaluate, repair, or supervise the generated skill.

## Scope and Architectural Constraints

The feature is outside the existing workflow state machine. It creates no `RunRecord`, task graph, worktree, durable recovery state, or domain aggregate.

The implementation must preserve these repository rules:

- The CLI action invokes exactly one application use case.
- Application code depends only on Domain, Ports, and other Application code.
- Codex JSON-RPC types, filesystem APIs, process APIs, sockets, and TTY handling remain in Infrastructure.
- Concrete construction occurs in `composition-root.ts`.
- Helpers used only by `CreateSkill` remain next to that use case rather than in `application/services`.

No new Domain module is required because this proof of concept introduces orchestration and external capabilities, not technology-independent business state or invariants.

## Selected Approach

The implementation uses Codex app-server exclusively. It does not install or inject `SessionStart` or `SessionEnd` hooks.

One app-server process owns three isolated threads:

```text
create-skill CLI
      |
      v
CreateSkill
      |
      +-- Thread 1: interactive workflow demonstration
      |       \-- thread/read -> demonstration.md
      |
      +-- Thread 2: non-interactive context analysis
      |       \-- turn/start -> skill-context.md
      |
      \-- Thread 3: interactive skill generation
              \-- one initial prompt referencing skill-context.md
```

Only Threads 1 and 3 have a TUI. Thread 2 runs internally through JSON-RPC. All three threads use the same local app-server runtime and remain contextually independent.

### Why three threads

The demonstration thread contains the full working conversation and may include incidental discussion, verbose command output, dead ends, and environment-specific details. Reusing it for analysis would retain all of that history as model context. Giving generation the raw capture would transfer the same noise to the skill author.

A fresh analysis thread receives the capture as an explicit artifact and has one responsibility: produce a faithful, compact workflow context. A fresh generation thread then receives only the declared workflow and that analyzed context. The additional model turn adds latency and token use, but produces a clearer responsibility boundary and keeps unnecessary demonstration data out of the generation conversation.

### Alternatives not selected

- **Ephemeral hooks plus app-server:** rejected because app-server already owns session identity, lifecycle, capture, and handoff. Hooks would add trust configuration, correlation, and cleanup paths.
- **Two threads with analysis in the demonstration thread:** rejected because the analyzer would inherit the entire interactive context instead of operating in an isolated conversation.
- **Two threads with generation analyzing the raw transcript:** rejected because the skill-authoring thread would receive all captured data and combine two distinct responsibilities.

## Codex Concepts and Process Topology

In app-server terminology:

- A **thread** is a stored conversation and contains turns.
- A **turn** is one user request plus the agent work that follows.
- An **item** is an observable unit inside a turn, such as a message, command, file change, or tool call.
- The **TUI** is a client process attached to a thread; closing the TUI does not itself delete the thread.

The process topology is:

```text
Happy Machine
├── codex app-server --listen unix://<socket>
├── codex app-server proxy --sock <socket>
│     \-- WebSocket-upgraded JSON-RPC control connection used by Happy Machine
├── codex --remote unix://<socket>
└── codex --remote unix://<socket> <generation-prompt>
```

Happy Machine launches all processes without a shell and passes every argument as a separate spawn argument. The app-server process and control connection live for the complete `create-skill` flow.

The Unix app-server endpoint accepts a standard HTTP WebSocket upgrade. The proxy only relays bytes, so the adapter performs the upgrade and WebSocket framing before its JSON-RPC client sends `initialize`, waits for its response, and sends `initialized`. The client correlates responses by request ID and consumes thread, turn, and item notifications independently of response order.

Codex `0.148.0` cannot resume a controller-created thread before that thread has a rollout. Interactive sessions therefore begin as fresh remote TUIs. The adapter observes `thread/started` on the shared control connection and binds Happy Machine's logical session ID to the vendor thread ID. Non-interactive analysis creates its thread lazily through `thread/start`.

## End-to-End Sequence

1. The CLI parses `create-skill --agent=codex` and rejects missing, duplicate, or unsupported agent values.
2. The CLI verifies that stdin and stdout are interactive terminals.
3. The CLI asks for the workflow description.
4. The CLI invokes `CreateSkill` once, passing the description, current directory, abort signal, and an inbound callback that presents and collects recording consent.
5. `CreateSkill` acquires the process-wide `create-skill` lock.
6. `CreateSkill` asks the agent-session port to perform static Codex compatibility checks.
7. The use case invokes the consent callback. Declining returns without creating capture data.
8. The use case removes safely identifiable abandoned capture workspaces and creates a private temporary workspace.
9. The Codex adapter starts app-server, the control proxy, and the JSON-RPC handshake.
10. `CaptureDemonstration` creates a managed demonstration session and launches its TUI without an initial prompt.
11. Happy Machine waits for the TUI child process. A normal exit continues; interruption or failure cancels the attempt.
12. The demonstration conversation is read with `thread/read` including turns. An empty demonstration is rejected.
13. Observable items are serialized chronologically to `demonstration.md`.
14. `AnalyzeDemonstration` creates a fresh, non-interactive analysis session and starts one read-only turn whose prompt references `demonstration.md`.
15. The adapter waits for `turn/completed`, validates the structured response, and writes the returned Markdown to `skill-context.md`.
16. The raw Markdown and managed demonstration and analysis threads are explicitly deleted before generation begins.
17. `LaunchSkillGeneration` creates a fresh persistent session and launches the second TUI with one initial prompt referencing `skill-context.md`.
18. Happy Machine waits only for the generation TUI process lifecycle. It sends no more messages and does not inspect the skill result.
19. On every terminal path, cleanup removes temporary artifacts, stops app-server, removes the socket, and releases the lock.

The generation thread becomes ordinary Codex history once its TUI starts successfully. Happy Machine does not expose retry or resume for the `create-skill` operation.

## Application Design

### Public use case: `CreateSkill`

`CreateSkill` is the only callable application operation for this feature.

Request:

```ts
interface CreateSkillRequest {
  workflowDescription: string;
  currentDirectory: string;
  confirmRecording: () => Promise<boolean>;
  signal?: AbortSignal;
}
```

Result:

```ts
type CreateSkillResult =
  | { outcome: "completed" }
  | { outcome: "canceled"; stage: "consent" | "demonstration" | "analysis" | "generation" };
```

Responsibilities:

- acquire and release exclusive ownership;
- perform compatibility checks before capture;
- control the consent boundary;
- start and stop the agent runtime;
- invoke the three stages in order;
- propagate cancellation;
- preserve the primary failure while collecting cleanup failures; and
- guarantee best-effort cleanup through `finally`.

Dependencies:

- `ExclusiveOperationLock`;
- `AgentSessions`;
- `SkillCaptureStore`;
- `CaptureDemonstration`;
- `AnalyzeDemonstration`; and
- `LaunchSkillGeneration`.

### Internal stage: `CaptureDemonstration`

Responsibilities:

- create the managed demonstration session;
- launch a TUI with no initial prompt;
- classify the child-process exit;
- read the complete observable conversation;
- reject an empty demonstration; and
- serialize it to a raw capture artifact.

Dependencies:

- `AgentSessions`;
- `SkillCaptureStore`; and
- the pure `serializeAgentConversation` helper.

It does not select relevant data, summarize the workflow, or create the skill.

### Internal stage: `AnalyzeDemonstration`

Responsibilities:

- create a fresh temporary analysis session;
- build the context-analysis prompt;
- request a read-only, network-disabled, non-interactive turn;
- validate a non-empty structured result;
- persist the result as `skill-context.md`; and
- dispose of the analysis session and raw demonstration inputs at the defined boundary.

Dependencies:

- `AgentSessions`;
- `SkillCaptureStore`; and
- the pure analysis prompt builder and result validator.

It does not open a TUI, converse with the user, or create a skill.

### Internal stage: `LaunchSkillGeneration`

Responsibilities:

- create a fresh persistent generation session;
- build the one initial generation prompt;
- launch a TUI connected to that session; and
- wait for the child process so lifecycle cleanup can run.

Dependencies:

- `AgentSessions`; and
- the pure generation prompt builder.

It does not submit follow-up turns, interpret agent output, locate a generated skill, or judge completion or quality.

## Port Contracts

The exact TypeScript may be refined during implementation, but the capability boundaries must remain equivalent to the following contracts.

### `AgentSessions`

```ts
type AgentSessionId = string;

interface AgentSessionOptions {
  currentDirectory: string;
  retention: "managed" | "persistent";
}

interface InteractiveExit {
  reason: "normal" | "interrupted" | "failed";
  exitCode?: number;
}

interface AgentInteractiveRequest {
  initialPrompt?: string;
  readableResources?: readonly string[];
}

interface AgentTurnRequest {
  prompt: string;
  filesystem: "read-only" | "workspace-write";
  network: boolean;
  expectedResult: "markdown";
  readableResources: readonly string[];
}

interface AgentTurnResult {
  status: "completed" | "interrupted" | "failed";
  content?: string;
}

interface AgentSessions {
  checkCompatibility(): Promise<void>;
  start(): Promise<void>;
  createSession(options: AgentSessionOptions): Promise<AgentSessionId>;
  runInteractive(
    sessionId: AgentSessionId,
    request?: AgentInteractiveRequest,
  ): Promise<InteractiveExit>;
  runTurn(
    sessionId: AgentSessionId,
    request: AgentTurnRequest,
  ): Promise<AgentTurnResult>;
  readConversation(sessionId: AgentSessionId): Promise<AgentConversation>;
  disposeSession(sessionId: AgentSessionId): Promise<void>;
  stop(): Promise<void>;
}
```

The port uses session language intentionally. `CodexAppServerSessions` maps a session to a Codex thread. No JSON-RPC method, Codex DTO, socket type, subprocess handle, or vendor error crosses this boundary.

`AgentConversation` is an ordered technology-independent representation of turns and observable items. Supported item categories include user messages, agent messages, command executions and results, tool calls and results, and file changes. New or unsupported Codex item variants map to an explicit neutral `other` item rather than leaking raw vendor data into Application.

Resource references are opaque to Application. The adapter makes the declared local artifacts readable by the target session without granting write access to the analysis turn.

### `SkillCaptureStore`

```ts
interface CaptureWorkspace {
  id: string;
}

interface CaptureArtifact {
  id: string;
  agentReference: string;
}

interface SkillCaptureStore {
  cleanupAbandoned(): Promise<void>;
  createWorkspace(): Promise<CaptureWorkspace>;
  writeDemonstration(
    workspace: CaptureWorkspace,
    markdown: string,
  ): Promise<CaptureArtifact>;
  writeSkillContext(
    workspace: CaptureWorkspace,
    markdown: string,
  ): Promise<CaptureArtifact>;
  removeArtifact(artifact: CaptureArtifact): Promise<void>;
  cleanup(workspace: CaptureWorkspace): Promise<void>;
}
```

Application treats `agentReference` as an opaque reference suitable for a prompt. Path construction, permissions, atomic writes, and deletion remain inside the filesystem adapter.

### `ExclusiveOperationLock`

```ts
interface OperationLease {
  id: string;
}

interface ExclusiveOperationLock {
  acquire(name: "create-skill"): Promise<OperationLease>;
  release(lease: OperationLease): Promise<void>;
}
```

The filesystem implementation obtains ownership atomically. A second active invocation receives a technology-independent busy error that Application translates to `capture_already_active`.

## Infrastructure Design

### Inbound CLI

`create-skill-command.ts` owns interface behavior:

- parse and validate the exact `--agent=codex` contract;
- require interactive stdin and stdout;
- collect a non-empty workflow description;
- present the recording disclosure and collect explicit consent through the callback passed to `CreateSkill`;
- invoke exactly one use case; and
- translate results and application errors into messages and exit codes.

`create-skill-presenter.ts` owns the user-facing text. `cli.ts` routes the new command and does not coordinate capture stages.

### Codex app-server adapter

`CodexAppServerSessions` implements `AgentSessions` and delegates adapter-local concerns:

- `codex-json-rpc-client.ts` owns initialization, request IDs, response correlation, notifications, server-initiated requests, and protocol errors.
- `codex-process-runtime.ts` owns app-server, proxy, TUI child processes, inherited terminal streams, socket readiness, and process termination.
- `codex-conversation-mapper.ts` converts Codex thread, turn, and item representations into `AgentConversation`.
- `codex-app-server-errors.ts` converts missing capabilities, failed turns, protocol failures, and process exits into port errors.

The demonstration and analysis threads are managed persisted threads and are explicitly deleted after analysis. The generation thread is persistent. Interactive thread IDs come from `thread/started`; the controller creates only the non-interactive analysis thread directly.

The analysis turn uses Codex's turn-scoped structured output internally. Its final assistant message must conform to an object with one non-empty `markdown` string. The JSON Schema is adapter-local; Application receives only the extracted content.

The adapter ignores unrelated notification methods and fails on malformed messages that are required to complete the current request or turn. It never treats arrival order as lifecycle order; completion is identified by matching thread and turn IDs.

### Filesystem capture adapter

`FilesystemSkillCaptureStore` creates a randomly named directory below the operating-system temporary directory. The directory mode is `0700`; regular capture files and ownership metadata use `0600`. Writes use a temporary sibling plus atomic rename so an interrupted write is never mistaken for a valid artifact.

The workspace contains only:

```text
happy-machine-create-skill-<random>/
├── .capture-owner.json
├── codex-app-server.sock
├── demonstration.md       # present only until analysis succeeds
└── skill-context.md       # present only until the flow ends
```

`.capture-owner.json` contains format version, PID, and creation time, but no captured content. It allows a later invocation to identify an abandoned workspace whose owner no longer exists. Cleanup must validate the marker, ownership, directory prefix, and dead PID before removing an abandoned directory.

### Filesystem lock adapter

`FilesystemExclusiveOperationLock` uses an atomic exclusive create for a stable `create-skill` lock. Its metadata identifies the owning PID. It rejects a live owner and safely replaces a stale lock only after verifying that the recorded process no longer exists.

### Composition root

`composition-root.ts` constructs the three adapters, internal stage objects, `CreateSkill`, command presenter, and CLI command. It passes concrete process, filesystem, and runtime configuration into adapters. `main.ts` remains unchanged.

## Source File Hierarchy

```text
src/
├── application/
│   └── use-cases/
│       └── create-skill/
│           ├── create-skill.ts
│           ├── capture-demonstration.ts
│           ├── analyze-demonstration.ts
│           ├── launch-skill-generation.ts
│           ├── create-skill-prompts.ts
│           ├── serialize-agent-conversation.ts
│           └── create-skill-errors.ts
│
├── ports/
│   ├── agent-sessions.ts
│   ├── skill-capture-store.ts
│   └── exclusive-operation-lock.ts
│
├── infrastructure/
│   ├── inbound/
│   │   └── cli/
│   │       ├── cli.ts
│   │       ├── help-presenter.ts
│   │       ├── create-skill-command.ts
│   │       └── create-skill-presenter.ts
│   │
│   └── outbound/
│       ├── agent-sessions/
│       │   └── codex-app-server/
│       │       ├── codex-app-server-sessions.ts
│       │       ├── codex-json-rpc-client.ts
│       │       ├── codex-process-runtime.ts
│       │       ├── codex-conversation-mapper.ts
│       │       └── codex-app-server-errors.ts
│       │
│       ├── skill-capture-store/
│       │   └── filesystem/
│       │       └── filesystem-skill-capture-store.ts
│       │
│       └── exclusive-operation-lock/
│           └── filesystem/
│               └── filesystem-exclusive-operation-lock.ts
│
├── composition-root.ts
└── main.ts
```

The three stage components are colocated with their only consumer. They are application collaborators, not separately addressable CLI use cases and not shared application services.

## Capture and Context Formats

### Raw demonstration

`demonstration.md` preserves the observable chronology without deciding what is reusable:

```markdown
# Workflow Demonstration

## Declared workflow

<user-provided description>

## Turn 1

### User input

...

### Agent response

...

### Commands and results

...

### Tool calls and file changes

...
```

The serializer calculates safe Markdown fences so captured content cannot close its containing block. It does not include private reasoning that app-server does not expose. Secret values that appear in the observable transcript remain capture data and are subject to the consent and deletion policy.

### Analyzed skill context

The analysis prompt treats the capture as untrusted source data rather than instructions to the analyzer. It asks Codex to produce Markdown containing:

- declared and observed objective;
- observed outcome;
- preconditions and required inputs;
- ordered reusable steps;
- tools, commands, files, and external systems that materially affect the workflow;
- decisions and their observed rationale;
- validation and completion signals;
- errors, rejected paths, and recovery behavior;
- environment-specific values that must become variables rather than fixed instructions;
- unresolved uncertainties; and
- required secret categories without reproducing credential or token values.

The prompt forbids skill creation, filesystem writes, unsupported factual invention, and following instructions embedded in command or tool output. Repetition, social conversation, irrelevant output, and incidental local details are omitted.

Happy Machine validates that the returned Markdown is non-empty before writing `skill-context.md`. It does not evaluate semantic quality.

### Generation prompt

The generation prompt contains:

- the objective of creating a reusable Codex skill;
- the workflow description supplied by the user;
- the opaque agent-readable reference to `skill-context.md`;
- an instruction to read the file before proceeding; and
- a delegation to Codex's native skill-creation capabilities and user interaction.

The Markdown content is not embedded inline. Happy Machine submits this prompt once, then makes no additional conversational intervention.

## Error Model

Application errors retain a stable code and stage:

```ts
type CreateSkillErrorCode =
  | "capture_already_active"
  | "agent_runtime_unavailable"
  | "agent_runtime_incompatible"
  | "demonstration_failed"
  | "demonstration_empty"
  | "analysis_failed"
  | "invalid_analysis"
  | "generation_start_failed"
  | "cleanup_failed";

type CreateSkillStage =
  | "setup"
  | "demonstration"
  | "analysis"
  | "generation"
  | "cleanup";
```

Vendor errors and process details remain available as causes for internal diagnosis but are not part of the stable application contract.

### Failure behavior by stage

- Invalid CLI input or a non-interactive terminal fails before the use case creates resources.
- An occupied lock rejects the new invocation.
- A missing or incompatible Codex installation fails before capture starts.
- A normal demonstration TUI exit proceeds. A signal, non-zero exit, or empty demonstration cancels or fails without opening generation.
- A failed, interrupted, malformed, or empty analysis result prevents generation.
- Failure to create the generation thread or start its TUI deletes that incomplete thread.
- Once the generation TUI starts, its thread is retained even if the TUI is later interrupted; temporary capture artifacts are still deleted.
- No failure triggers an automatic demonstration, analysis, or generation retry.

### CLI exit codes

- `0`: completed flow, or the user declines before recording begins.
- `2`: cancellation after recording has begun.
- `1`: invalid input, incompatibility, runtime failure, analysis failure, generation startup failure, or incomplete cleanup.

## Cancellation and Cleanup

`CreateSkill` owns one idempotent cleanup path. On cancellation or failure it:

1. interrupts an active non-interactive turn;
2. asks any active child TUI to terminate;
3. disposes temporary threads while app-server is available;
4. stops the proxy and app-server processes;
5. removes capture files, socket, ownership marker, and workspace directory; and
6. releases the exclusive lease.

Cleanup attempts every independent step even when an earlier cleanup step fails. The primary operational error remains primary; cleanup failures are attached and reported. The CLI must not claim that temporary data was deleted if deletion did not succeed, and it should identify the remaining private workspace for manual removal.

`SIGKILL`, process crashes, and power loss cannot execute `finally`. The next invocation performs the validated abandoned-workspace cleanup after obtaining exclusive ownership. This is cleanup only; it never recovers or resumes a capture.

## Privacy and Security

- Recording begins only after explicit consent.
- The raw transcript is deleted before generation starts.
- The generation agent receives only the analyzed Markdown context.
- The analysis turn is read-only, network-disabled, and non-interactive.
- Capture content, prompts, command output, and tool output are never written to diagnostic logs.
- The control socket is local and stored in the private temporary workspace.
- Child processes are spawned without a shell to prevent interpolation of workflow text or artifact references.
- App-server DTOs and unknown protocol data never cross into Application.
- The generated skill is not temporary capture data.

The persistent generation thread may retain model-visible evidence of `skill-context.md` after Codex reads it. That conversation follows normal Codex session retention. Happy Machine's deletion guarantee covers the raw demonstration thread and the temporary filesystem artifacts it owns, not the normal generation conversation delegated to Codex.

## Codex Compatibility

The proof of concept targets Codex CLI `0.148.0` as the initial validated baseline. Compatibility is capability-based rather than version-only.

Before capture, the adapter verifies:

- the `codex` executable is available;
- `app-server` accepts a Unix socket listener;
- the app-server proxy can connect to that socket;
- the root remote TUI option, `codex --remote`, is available; and
- the expected CLI argument forms are present.

After consent and runtime startup, the adapter verifies:

- the JSON-RPC initialization handshake;
- fresh interactive thread notification and controller thread creation;
- thread read/delete behavior needed by managed sessions;
- turn start and completion notifications; and
- that the installed protocol schema exposes the turn-scoped structured-output field required by the analyzer.

The actual structured response is validated when the analysis turn runs; compatibility probing does not make an additional model call.

Runtime handshake or capability failure after consent still occurs before a demonstration thread is opened. It triggers full cleanup and asks the user to start a new attempt after fixing Codex.

Codex app-server and some transports are documented as experimental. All protocol assumptions remain isolated in the Codex adapter, and the command fails clearly on unsupported versions rather than falling back to hooks or transcript scraping.

The release smoke test against Codex CLI `0.148.0` established the concrete baseline above: the Unix proxy requires WebSocket framing, empty controller-created threads cannot be resumed by the TUI, and a local WebSocket close is required so control-client shutdown does not wait indefinitely for the remote peer.

## Test Strategy

Automated tests do not require a real Codex account or a model call. Ports use fakes, and adapter tests use a deterministic executable fixture at `tests/fixtures/fake-codex.mjs`.

### Application tests

`tests/create-skill.test.ts` verifies:

- lock and runtime ordering;
- consent boundaries;
- demonstration, analysis, and generation ordering;
- three distinct session IDs;
- no generation after an earlier failure;
- generation-session retention after TUI startup;
- cancellation propagation; and
- cleanup on every exit path.

Stage-focused tests verify:

- `capture-demonstration.test.ts`: normal and abnormal TUI exits, empty conversation handling, capture reading, and serialization.
- `analyze-demonstration.test.ts`: fresh managed context, one read-only and network-disabled turn, structured-result validation, and early raw-data deletion.
- `launch-skill-generation.test.ts`: fresh persistent session, exactly one initial prompt, artifact reference, and no follow-up turn.
- `serialize-agent-conversation.test.ts`: chronological ordering, supported item mappings, unknown items, and safe Markdown fences.

Prompt tests assert required semantic clauses rather than snapshotting complete wording.

### Adapter tests

- `codex-app-server-sessions.test.ts`: handshake, session lifecycle, read/delete, structured turns, and port error mapping.
- `codex-json-rpc-client.test.ts`: request correlation, interleaved notifications, malformed responses, server errors, and turn completion matching.
- `codex-process-runtime.test.ts`: spawn arguments, inherited TTY streams, socket readiness, normal exits, signals, and bounded process shutdown.
- `filesystem-skill-capture-store.test.ts`: restrictive permissions, atomic writes, early artifact removal, idempotent cleanup, and abandoned-workspace validation.
- `filesystem-exclusive-operation-lock.test.ts`: atomic exclusion, live-owner rejection, stale-owner replacement, and safe release.
- `create-skill-cli.test.ts`: help, exact agent validation, TTY requirement, description, consent, one use-case invocation, messages, and exit codes.

### End-to-end fixture test

The fake Codex executable simulates app-server JSON-RPC and both TUI child processes. The full CLI test asserts:

1. two interactive TUI launches;
2. one internal analysis session;
3. three distinct sessions;
4. exactly one analysis turn and one generation prompt;
5. deletion of `demonstration.md` before generation;
6. generation prompt reference to `skill-context.md`; and
7. final cleanup of every Happy Machine temporary artifact.

### Manual smoke test

A release smoke test with the baseline Codex version validates the behavior that a fake process cannot fully reproduce:

- both TUIs occupy the initiating terminal tab;
- the demonstration receives no injected task;
- closing the demonstration normally triggers analysis and the second TUI;
- the generation prompt is already submitted and running;
- Codex can read the analyzed context and continue its native skill-creation flow; and
- no capture workspace or demonstration thread remains after exit.

## Acceptance Criteria

Implementation is complete when:

1. `happy-machine create-skill --agent=codex` is documented in global and command help.
2. Missing or unsupported agent values and non-TTY execution fail clearly.
3. Recording cannot begin without a workflow description and explicit consent.
4. A fresh demonstration TUI opens without an injected prompt.
5. Any normal demonstration TUI exit advances the flow; interruption cancels it.
6. app-server provides the captured conversation without hooks or terminal scraping.
7. A fresh isolated analysis thread produces validated Markdown context.
8. Raw capture data and the demonstration thread are deleted before generation.
9. A fresh generation TUI begins automatically with exactly one prompt referencing the analyzed Markdown.
10. Happy Machine sends no follow-up generation prompts and does not evaluate the skill.
11. Only one `create-skill` flow may be active at a time.
12. Success, cancellation, failure, and signals run idempotent cleanup.
13. Automated tests cover orchestration, adapters, process lifecycle, isolation, errors, and cleanup without a real Codex account.

## Non-Goals

- Agents other than Codex.
- Hooks as a fallback or supplementary integration.
- More than one active capture.
- Capture history, retry, resume, or recovery.
- Persisting `demonstration.md` or `skill-context.md`.
- Evaluating, testing, scoring, repairing, or locating the generated skill.
- Prescribing which Codex skill, subagent, plugin, or tool performs creation.
- Adding create-skill to the existing workflow execution state machine.
- Abstracting for speculative future vendors beyond the technology-independent ports already required by the architecture.
