# Create Skill Proof-of-Concept Product Design

**Status:** Approved

**Date:** 2026-08-20

**Last updated:** 2026-08-21

**Technical design:** [Create Skill Proof-of-Concept Technical Design](./2026-08-21-create-skill-poc-technical-design.md)

## Goal

Prove that Happy Machine can capture a real workflow performed by a user with Codex and hand that experience to a fresh Codex session that creates a reusable skill. Happy Machine coordinates the handoff but does not become a skill author, evaluator, or supervisor.

## Product Principle

The proof of concept gives Happy Machine the smallest possible responsibility. It owns the entry experience, explicit recording consent, transition between two user-visible Codex sessions, isolated preparation of the captured context, the single initial generation prompt, and temporary-data cleanup. Once that prompt is submitted, Codex owns the skill-creation experience.

The feature is a standalone utility. It is not part of Happy Machine's normal task-execution experience or workflow state machine.

## Codex Integration Boundary

The proof of concept uses Codex app-server exclusively. It does not configure, inject, or depend on `SessionStart`, `SessionEnd`, or other Codex hooks, and it does not scrape terminal output to capture the demonstration.

One app-server process coordinates three isolated Codex threads:

1. a fresh interactive thread for the user's demonstration;
2. a fresh non-interactive thread that analyzes the captured demonstration and produces focused Markdown context; and
3. a fresh interactive thread that owns skill generation.

The first and third threads are the two user-visible Codex sessions described by the product journey. The analysis thread is an internal context-preparation step: it opens no TUI and does not create the skill. Its analysis prompt is separate from the single generation prompt.

## Command Contract

The proof of concept is started with:

```text
happy-machine create-skill --agent=codex
```

The `--agent` flag is required, and `codex` is the only accepted value. There is no implicit default agent and no support for additional agents in this version.

Only one `create-skill` run may be active at a time. A second attempt must be rejected clearly rather than creating concurrent recordings.

## User Journey

### 1. Declare the workflow

Happy Machine asks the user for a short description of the workflow they are about to demonstrate. It does not ask for a skill name, location, structure, or scope.

Example:

```text
What workflow are you going to perform?
Investigate a production bug and prepare the fix.
```

### 2. Confirm recording

Before opening Codex, Happy Machine explains that:

- the complete Codex conversation will be captured;
- the captured material will be used to create a skill;
- the session must remain dedicated to the declared workflow; and
- the user may cancel before recording begins.

Recording starts only after explicit confirmation. Cancelling at this point exits without capturing a session.

### 3. Demonstrate the workflow

Codex opens in the same terminal tab in a fresh interactive session. Happy Machine does not inject a task into this session. The user starts and performs the workflow as they normally would, keeping the full conversation dedicated to that workflow.

Any normal Codex exit ends the demonstration successfully. Happy Machine does not attempt to distinguish `/exit`, `/quit`, or another normal exit. Interrupting the process or closing the terminal abnormally cancels the attempt.

### 4. Prepare the captured context

After the demonstration exits normally, Happy Machine captures the observable conversation through app-server. It then starts a fresh, non-interactive Codex thread with one analysis prompt that treats the capture as source data and produces focused Markdown context for skill creation.

This internal thread does not open a TUI, ask the user questions, or create a skill. Once the analyzed context is valid, Happy Machine deletes the raw demonstration and its thread before generation begins.

### 5. Start skill generation

Happy Machine starts the second user-visible, fresh Codex session in the same terminal tab. There is no confirmation or manual copy-and-paste step between sessions.

The second session opens with its initial prompt already submitted and running. That prompt provides:

- the objective of creating a reusable skill;
- the workflow description supplied by the user; and
- the analyzed demonstration represented as focused Markdown context.

Happy Machine makes no further conversational intervention after submitting this generation prompt.

### 6. Delegate to Codex

Codex owns the remainder of the experience through its native capabilities. Happy Machine does not prescribe:

- which Codex skill, agent, subagent, or tool to use;
- how to resolve ambiguity or ask the user questions;
- how to create or validate the skill;
- the skill's name, scope, or destination; or
- how Codex decides that its creation process is complete.

If a scope or destination choice is necessary, Codex consults the user as part of its own flow. The proof of concept defines no additional completion protocol for the second session.

## Responsibility Boundary

Happy Machine is responsible only for:

- validating the command and the explicit `codex` agent value;
- collecting the workflow description;
- presenting the recording notice and obtaining consent;
- enabling the dedicated demonstration session;
- capturing the demonstration through Codex app-server without hooks;
- running one isolated, non-interactive analysis turn to prepare the Markdown context;
- starting the fresh generation session in the same terminal;
- submitting one initial generation prompt; and
- deleting temporary capture data when the flow ends.

Codex is responsible for the complete skill-creation process after the initial generation prompt. Temporary-data cleanup is lifecycle housekeeping and must not cause Happy Machine to direct, monitor, or alter the Codex conversation.

## Privacy and Data Retention

The recorded conversation and generated Markdown context are temporary inputs. After successful analysis, Happy Machine deletes the raw demonstration and demonstration thread before generation begins. It deletes the analyzed Markdown context when the flow ends, including after success, cancellation, or interruption.

The proof of concept does not retain a capture for retry or recovery. After an interrupted attempt, the user must start a new demonstration. The generated skill itself is not temporary capture data and is governed by the destination selected through Codex's native creation flow.

## Cancellation and Failure Behavior

- Cancellation before explicit consent exits without starting a recording.
- A normal exit from the first Codex session advances the flow; interruption or abnormal termination cancels the attempt.
- Failure or interruption of the internal analysis thread prevents the generation session from starting.
- An interruption in either session ends the Happy Machine flow and deletes the temporary capture data.
- A failed or interrupted attempt cannot be resumed; the user starts again with a new command.
- Happy Machine does not judge whether Codex produced a good skill and does not retry or repair Codex's work.

Failures should be reported with a short, understandable message that states whether temporary-data cleanup completed and that a new run is required. Happy Machine must not claim deletion when cleanup remains incomplete.

## Proof-of-Concept Success Criteria

The proof of concept succeeds when:

1. A user can declare and explicitly consent to recording a workflow.
2. The user can perform that workflow normally in Codex in the initiating terminal tab.
3. Any normal exit from the demonstration transitions into automated context preparation.
4. A separate non-interactive Codex thread analyzes the capture without hooks or terminal scraping.
5. The raw demonstration and its thread are deleted before generation begins.
6. The generation session begins automatically with the workflow description and analyzed Markdown context, without manual copying.
7. Happy Machine submits exactly one generation prompt and then delegates the experience to Codex.
8. Temporary capture data is removed when the flow ends.

Success means that the capture-and-handoff experience works. It does not mean that Happy Machine independently verifies the generated skill's quality.

## Non-Goals

- Supporting agents other than Codex.
- Allowing more than one active capture.
- Providing capture history, retry, resume, or recovery.
- Evaluating, testing, scoring, or guaranteeing the generated skill.
- Choosing the skill's name, scope, destination, or internal structure.
- Prescribing Codex's native skill-creation workflow.
- Sending follow-up prompts or supervising Codex after the initial generation prompt.
- Using Codex hooks or terminal-output scraping as a capture fallback.
- Integrating `create-skill` into Happy Machine's normal task workflow or state machine.
- Defining app-server transport, JSON-RPC, process-management, filesystem, or adapter implementation details; those belong to the referenced technical design.
