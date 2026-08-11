# Task 05: Validate and atomically commit results and documents

## Objective

Turn result.json and the Markdown files declared by an agent into a durable result only when the complete contract is valid, without promoting partial evidence or leaving a half-committed transition.

## Functional value

Workflow decisions are based on complete, reproducible evidence. A corrupt, malicious, or incomplete result fails in a controlled way and never contaminates the context of later states.

## Dependencies

- Task 04.

## Scope

- Require result.json to exist at the assigned path and contain valid JSON.
- Require one string outcome and one documents array in every normal result.
- Validate the outcome against the current normal state's closed outcome set.
- Allow an optional error only as serializable diagnostic information, never as routing control.
- Require every documents entry to be relative to the assigned output area.
- Canonicalize every path and reject traversal, symbolic links, or any resolution that escapes the output area.
- Require every declared document to exist, be a regular file, and have a .md extension.
- Reject collisions with an already committed provenance path.
- Copy or content-address every document into durable storage and record its hash and provenance.
- Commit in one logical operation: validated result content, document references and hashes, attempt terminal status, outcome, transition or task contribution, and ordered events.
- Treat files written before a failed commit as unreferenced audit material.
- Retain outputs from failed or invalid attempts only as audit material and exclude them from context.md.
- Treat a missing or invalid result.json, unknown outcome, and invalid document as technical attempt failures.
- With max_attempts set to 1, end the normal state and run as failed when validation fails.
- Preserve project-workspace changes made by a failed attempt without promoting, reverting, or using them to select an outcome.

## Out of scope

- Running additional retries or waiting for retry_delay; that belongs to Task 06.
- Defining the result shape for parallel tasks; that belongs to Task 07.
- Rolling back source files.
- Analyzing the quality or meaning of produced Markdown.
- Overwriting or editing committed documents.

## Acceptance criteria

1. **Valid normal result:** Given a result.json with an allowed outcome and two valid Markdown documents, when the attempt finishes, then both are stored with hash and provenance, the outcome and transition are committed, and only then does the next state start.
2. **Missing or malformed result:** Given that result.json is missing or invalid JSON, when Orca finishes, then the attempt fails technically and no output enters durable context.
3. **Unknown outcome:** Given a state that does not declare uncertain, when the agent returns uncertain, then the attempt fails, no transition is selected, and the run fails after its single allowed attempt is exhausted.
4. **Incomplete contract:** Given a result without a string outcome or documents array, when it is validated, then it is rejected as a technical failure.
5. **Output-area escape:** Given an absolute document path, traversal path, or symbolic link resolving outside the assigned area, when it is validated, then the result is rejected and no external content is copied.
6. **Document type:** Given a missing path, directory, special file, or file without a .md extension, when it is validated, then the complete result is rejected.
7. **Batch atomicity:** Given that one of several documents is invalid, when validation runs, then none of the documents are committed and no durable outcome or transition exists for the attempt.
8. **Failure during commit:** Given a crash after durable files are written but before the logical operation completes, when state is recovered, then those files remain unreferenced audit material and do not appear in context.md.
9. **Immutability:** Given an already-committed document, when another result attempts to use the same provenance path, then the collision is rejected and the original remains intact.
10. **Failed-attempt source changes:** Given an invalid attempt that modified the project workspace, when the run ends, then the changes remain present but do not appear as documents or produce an outcome or transition.
11. **Diagnostic-only error:** Given a valid result.json with a serializable error and an allowed outcome, when it is processed, then routing depends only on outcome and the error is retained as diagnostic data.

## Required tests

- Table tests for every structural and path rule of result.json.
- Tests with regular files, directories, symbolic links, traversal, and invalid extensions.
- Fault-injection tests before, during, and after the logical commit operation.
- End-to-end test for an unknown outcome with max_attempts 1.
- Test proving that invalid outputs and source changes remain separate from durable context.

## Traceability

- PRODUCT.md: Invariants 5.2, 5.5, and 5.9–5.11; Sections 12.1, 12.3, 13, 14, 16.1, 19.3, and 23.2.
- Normative scenarios: 25.2 and 25.5.

## Definition of done

- Every normative invalid-result cause has an automated test.
- The fault-injection suite proves that no partially committed durable state can become visible.
- No document from a failed or invalid attempt appears in a later context.md.
- Hashes and provenance make the immutability of every committed document verifiable.
