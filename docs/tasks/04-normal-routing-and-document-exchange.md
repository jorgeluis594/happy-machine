# Task 04: Route normal states dynamically and exchange documents

## Objective

Execute workflows with multiple normal states where each agent selects a valid outcome and delivers immutable Markdown documents that become available to later visits.

## Functional value

Happy Machine stops being a single-task launcher and becomes a decision coordinator: an agent's result selects exactly the next state, and its documents form the durable context for subsequent agents.

## Dependencies

- Task 03.

## Scope

- Execute a sequence of two or more reachable normal states.
- Accept semantic outcomes defined by the workflow and resolve each to exactly one state or terminal target.
- Treat succeeded and failed as ordinary names in a normal state; only $succeeded and $failed are terminal targets.
- Distinguish a negative business result from run failure; for example, rejected may lead to $succeeded.
- Allow a successful attempt to declare zero or more Markdown documents.
- Include every input and document committed by earlier successful attempts in each new visit.
- Index each document by producing state, visit number, task ID, name, and immutable path.
- Assign a stable ID to a normal state's implicit task.
- Use provenance paths equivalent to states/{state-id}/visits/{visit-number}/tasks/{task-id}/documents/{name}.md.
- Allow the same basename in different states, visits, or tasks without overwriting an earlier version.
- Create a new immutable context.md for each visit.
- Resolve instructions, prompt, runtime, and policies from the snapshot while applying valid policy overrides.
- Do not start the next state until the prior result, documents, outcome, and transition are durable.
- Keep workflow documents separate from changes an agent makes in the project workspace.
- Do not infer outcomes from prose, semantically merge documents, or create commits, merges, reverts, or source-tree rollback.

## Out of scope

- Cycles back to previously visited states; those belong to Task 08.
- Parallel states; those belong to Task 07.
- Retries and timeouts; those belong to Task 06.
- Exhaustive result validation and crash atomicity; those belong to Task 05.
- Automatic semantic synthesis between documents.

## Acceptance criteria

1. **Dynamic routing:** Given a review state with approved and needs_revision outcomes, when result.json declares approved, then the result is committed and only the target configured for approved is entered.
2. **Alternate outcome:** Given the same state, when needs_revision is returned, then the approved target is not executed and exactly the needs_revision target is selected.
3. **Successful negative business decision:** Given rejected: $succeeded, when the agent returns rejected, then the run ends as succeeded and retains rejected as its last outcome.
4. **Nonreserved name:** Given a normal state that declares failed as an outcome targeting another state, when the agent returns failed, then the ordinary transition is followed and no technical or terminal failure is forced.
5. **Multiple-document exchange:** Given that the first state declares two valid Markdown files, when the next state begins, then both appear in context.md with hash, provenance, and immutable paths.
6. **Repeated basenames:** Given that two states produce report.md, when a third state receives context, then both versions appear at different provenance paths and neither was overwritten.
7. **New visit, new context:** Given a forward transition to a new state, when its visit is created, then it receives a new snapshot containing every document committed so far and that snapshot does not change during the visit.
8. **Durable ordering:** Given a valid result, when durable commit of its documents, outcome, or transition fails, then the next state does not begin.
9. **Workspace separated from context:** Given that an agent changes a source file not declared in documents, when the next state starts, then the file is not automatically indexed in context.md and does not influence routing.
10. **No prose control:** Given a document or log containing the name of another outcome, when result.json declares a different valid outcome, then only result.json controls the transition.

## Required tests

- End-to-end tests for each branch of a workflow containing at least three states.
- Test for a negative business outcome that terminates at $succeeded.
- Test for normal outcomes named succeeded and failed.
- Test with multiple documents and repeated basenames.
- Integration test that blocks persistence and proves the next state is not launched.
- Test separating project-workspace modifications from declared documents.

## Traceability

- PRODUCT.md: Section 2; Invariants 5.2–5.4 and 5.9–5.11; Sections 4.4–4.6, 8.1–8.4, 10.3–10.4, 11, 12.1, 13, 14, and 19.3.
- Normative scenarios: 25.1 and the separation described by 25.5.

## Definition of done

- Every branch declared by the workflow fixtures has an observable end-to-end test.
- Committed documents are immutable, traceable, and visible starting in exactly the appropriate later visit.
- No path can launch the next state before the previous transition is committed.
- Routing never depends on stdout, stderr, Markdown content, or implicitly meaningful names.
