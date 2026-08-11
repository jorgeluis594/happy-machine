---
name: implementation
description: Guide implementation through contextual analysis, continuous development, and validated commits. Use for requests to implement, change, fix, or refactor project code.
---

# Implementation

## Steps

1. Analyze the request, relevant code, tests, and project conventions.
2. Read `docs/ARCHITECTURE.md` completely and adapt the implementation to the documented architecture.
3. Inspect Git status and preserve unrelated user changes.
4. Implement continuously.
5. Add or update tests and run focused checks while developing.
6. Regularly evaluate whether the accumulated changes are ready for a commit.
7. When they are ready, run `npm test` and `npm run typecheck`.
8. If both commands pass, inspect the diff, stage only the related changes, and create a concise commit describing their meaning.
9. Continue implementing and repeat the flow until all requirements are complete.
10. Run `npm test` and `npm run typecheck` again before reporting completion.

## Commit readiness

Changes are ready for a commit only when:

- They complete a coherent part of the requirements.
- They are understandable and reversible on their own.
- They contain no intentionally incomplete or broken behavior.
- They comply with `docs/ARCHITECTURE.md`.
- They include the tests needed to validate the behavior.
- Their diff has one clear meaning.
- They exclude unrelated user changes.

If any condition is false, continue implementing without committing. If tests or type checking fail, fix the failures and rerun both commands before committing.
