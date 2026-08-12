# Durable Recovery and Exclusive Controller Leases

## Goal

Implement Task 09 so a new controller can reconstruct and continue a durable
run without the prior process's memory, while a fenced lease guarantees that
only the current controller can mutate the run. Recovery must inspect Orca
provenance before any launch and preserve at-most-once external execution across
every identified crash window.

Task 09 exposes recovery through an internal application use case. The public
`resume` CLI interaction, signal handling, and detach experience remain Task
10.

## Durable Model

`RunRecord` stores a controller lease containing controller ID, monotonically
increasing fencing token, configured lease duration, acquisition and renewal
times, and expiry. Lease acquisition, renewal, loss, takeover, and release are
recorded as ordered events.

The durable definition snapshot remains the only execution definition used by
recovery. The repository loads and validates both `run.json` and the snapshot
manifest, reconstructing effective policies, state definitions, visits, tasks,
attempts, transition counters, deadline, documents, executor references,
failures, and events. Malformed or inconsistent durable data fails with a
storage/corruption run failure; recovery does not repair it automatically.

In-memory queues and worker counts are derived from durable task states. The
controller never persists a queue cursor as authoritative state.

## Fenced Filesystem Lease

The run repository port gains operations to load a run and its snapshotted
definition, acquire control, renew control, release control, and save under a
fencing token. Initial run allocation is the only unfenced creation operation.

The filesystem adapter serializes lease changes with a per-run coordination
directory created atomically. Coordination metadata identifies its owner and
expiry so a lock abandoned by a crashed process can be reclaimed only after
the configured lease interval. Under that coordination lock, the adapter reads
the current durable run, compares the lease against the supplied controller and
time, assigns a strictly higher fencing token on acquisition/takeover, records
the event, and atomically replaces `run.json`.

Every later save rechecks the durable lease and supplied token while holding
the same coordination lock. A stale controller therefore cannot write after a
takeover even if its process resumes. Renewal extends expiry using only the
snapshotted project-level `controller_lease`; callers cannot supply a different
duration. A valid competing lease throws `run_already_controlled` without
changing the run, lease, events, attempts, or status.

Lease expiry grants only controller ownership. It never proves an Orca task or
worker stopped.

## Shared Controller State Machine

The existing execution loop is extracted into an application service shared by
new-run execution and `RecoverWorkflow`. Both paths operate through a
controller-scoped repository session and therefore use the same fenced saves,
limits, retry rules, result validation, document publication, transitions, and
parallel join behavior.

Recovery derives one next action from durable state:

- no visits: enter the initial state;
- committed nonterminal transition without its target visit: enter that target;
- incomplete normal visit: recover or start its current/next attempt;
- partial parallel visit: reconstruct settled, active, retryable, and queued
  tasks, then resume bounded scheduling from those records;
- valid external completion without local commit: validate and commit it;
- committed state outcome/transition: advance without reprocessing evidence;
- terminal run: return without scheduling.

Repeated recovery evaluates the same durable predicates, so an already
committed outcome, transition, document, join, or logical event is never added
again.

## Attempt Launch and Provenance Recovery

An attempt identity and `launching` record are durably saved before external
inspection or launch. The task executor port gains a recovery operation keyed
by stable attempt identity and optional known executor references.

The Orca adapter uses the current documented machine-readable commands:

- `orca orchestration task-list --json` to locate a task whose persisted
  specification contains the Happy Machine attempt identity;
- `orca orchestration dispatch-show --task <task-id> --json` to obtain task,
  dispatch, terminal, worker state, and completion evidence.

The adapter translates Orca into technology-independent observations:

- `not_found`: no matching task or dispatch exists; launch is permitted;
- `active`: identifiers exist and observation continues without launch;
- `completed`: terminal external work exists and local result processing may
  continue without launch;
- `failed`: external failure becomes the ordinary retryable attempt failure;
- `start_unknown` or `stop_unknown`: uncertainty, never permission to launch or
  retry.

When an observation supplies identifiers, the controller persists them under
its fencing token before recording the attempt as running. If provenance is
`not_found`, the same stable identity is launched once. A crash after Orca
launch but before the callback save is recovered by the next provenance search.

Active recovery waits on the existing dispatch rather than creating a new Orca
task. Completed recovery reads the existing `result.json` and output directory,
then uses the ordinary validation and commit path.

## Completion Idempotency

Transition publication remains one fenced atomic `run.json` replacement.
Recovery checks durable visit outcome and transition count before processing
external completion; committed work is never replayed.

Document staging becomes idempotent for the exact same provenance. If a durable
destination already exists but is not indexed because a crash occurred during
commit, recovery hashes source and destination. Matching content produces the
same `DocumentRecord`; mismatched content is a safe storage failure and is never
overwritten. Duplicate declarations within a result remain invalid.

Logical events whose operation may be revisited use stable keys based on run,
visit, task, attempt, and operation. The controller appends them only when the
corresponding durable state change is not already present.

## Lease Renewal and Loss

The controller renews before half of the configured lease period elapses and
before every scheduling or commit boundary. While waiting for Orca, retry
delays, cancellation, or reconciliation, a renewal loop runs independently of
external completion.

If renewal reports a different token/controller or cannot persist safely, the
controller records lease loss only when still fenced, stops scheduling, and
returns control. It does not cancel work merely because ownership was lost;
the next controller recovers external state. A storage failure before a durable
advance leaves the last committed record authoritative and schedules no next
work.

## Recovery Failures

`start_unknown` and `stop_unknown` are reconciled within the existing bounded
observation window. If they remain unknown, the run ends with a stable engine
failure while the current controller still owns the fence. No retry or new
attempt is created.

Corrupt storage, definition snapshot inconsistency, content mismatch during
idempotent publication, or inability to create a required workspace after run
creation ends the run as failed when that terminal record can be safely
persisted. If persistence itself is unavailable, the operation returns an
error and leaves the last complete durable record recoverable; it never
schedules subsequent work.

## Architecture

Lease ownership, expiry, and fencing rules belong to the execution domain. A
shared application controller service coordinates reconstruction, renewal,
provenance inspection, external observation, and existing execution behavior.
`ExecuteWorkflow` allocates/snapshots then delegates; `RecoverWorkflow` loads,
acquires, then delegates.

The run-repository port owns technology-independent durable loading and fenced
control operations. Its filesystem adapter owns atomic files, coordination
directories, manifest parsing, corruption checks, and idempotent copies. The
task-executor port owns recovery observations; its Orca adapter owns command
selection and JSON/state translation. The composition root wires the new use
case without exposing a public resume command.

## Testing

Deterministic fault-injection tests cover:

- crash after durable `launching` and before Orca launch, proving one later
  launch;
- crash after launch and before identifier persistence, proving provenance
  lookup and no duplicate;
- crash after identifier persistence while active, proving observation of the
  existing dispatch;
- crash after external completion and before local commit, proving one
  validated commit;
- crash during document/transition commit, proving either last-state recovery
  or one complete commit with no partial index;
- repeated recovery after completion, proving documents, outcomes, transition
  count, joins, and logical events are unchanged;
- two controllers contending for a valid lease with no mutation by the loser;
- controlled expiry/takeover with active Orca work and no duplicate launch;
- renewal beyond one lease period and stale-token write rejection;
- Orca adapter parsing for not-found, active, completed, failed,
  `start_unknown`, and `stop_unknown` states;
- irreconcilable uncertainty failing without retry;
- a partially settled parallel visit reconstructed solely from durable files,
  preserving settled tasks and resuming only active/queued work.

Final verification runs lint/format fixes, the full test suite, TypeScript
checking, and an explicit audit against all ten acceptance criteria, every
required crash boundary, and the Task 09 definition of done.
