# Write Retrievable Memories

Write titles and content for deterministic textual recall while preserving natural, accurate language.

## Account for Retrieval Semantics

Assume that recall:

- Matches only the current active title and content.
- Splits queries into literal whitespace-delimited terms joined with AND.
- Does not infer meaning or expand synonyms; exact and tokenized tag filters
  constrain candidates but cannot satisfy a title or content term.
- Weights title text more strongly than content text.
- Uses accurate importance and confidence as secondary ranking signals.
- Returns content verbatim and omits the version required for mutation.

## Write the Title

- State the memory's central idea with short, discriminative project terminology.
- Prefer the canonical names used by the project.
- Place only genuinely central retrieval terms in the title.
- Avoid generic titles, activity status, and keyword lists.

## Write the Content

- Express one complete assertion or procedure without relying on the originating conversation.
- Include the minimum context needed to interpret scope and applicability.
- Use terms a future agent is likely to query when those terms belong naturally to the assertion.
- Include alternate terminology only when it is established in the project and materially improves retrieval.
- State current validity or obsolescence explicitly when it changes the meaning.
- Avoid keyword stuffing, artificial repetition, and unsupported search terms.

## Preserve Ranking Integrity

Assign type, importance, and confidence for their actual meaning. Never distort content or scores to force higher rank. Use atomicity and precise language to improve relevance.

Before persisting, confirm that a future agent can understand the title and content verbatim and can retrieve the idea without relying exclusively on tags.
