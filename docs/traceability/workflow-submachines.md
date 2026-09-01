# Workflow submachines certification evidence

This bounded report maps Task 08's functional acceptance contract and CU-01
through CU-08 to public or integration evidence. The JSON source beside this
file is the machine-readable manifest. Evidence is intentionally summarized:
child states, visits, attempts, and logs remain in the child run's own history.

## Observable implementation evidence

- Parent status renders `type=workflow`, durable phase, `child_run`, evaluator
  attempt count, outcome, and a bounded error value.
- Parent history renders bounded child links; child status and history render
  the inverse `Parent:` coordinate.
- Lifecycle events carry parent coordinate and child identity and are emitted
  idempotently across recovery.
- Existing registry, snapshot, recovery, cancellation, parallel, and worktree
  suites remain the regression evidence for the inherited contract.

## Decision record

Task 08 uses stable-coordinate event deduplication. A recovery pass may observe
the same durable boundary more than once, so the event is retained once per
boundary (and per evaluator attempt) while the child remains independently
inspectable. Missing legacy wrapper fields are treated as agent work by the
existing compatibility rule; no synthetic child history is created.

## Certification status

The manifest is the bounded traceability source for this implementation. Test
execution is the authority for pass/fail status; entries that refer to suites
owned by earlier tasks are regression/conformance evidence and are not product
changes in Task 08.
