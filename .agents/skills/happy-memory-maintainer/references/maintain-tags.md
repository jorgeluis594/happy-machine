# Maintain Keyword Tags

Treat tags as structured keywords for grouping and filtering memories. Keep them separate from memory type, importance, and confidence.

## Discover Vocabulary

For each candidate keyword:

1. Form a specific non-empty query from the intended topic.
2. Run exactly `happy-memory tags search "<query>" --limit 10`.
3. Inspect only each returned tag's canonical name, normalized name, description, and active-memory count.
4. Reuse an adequate canonical tag before creating a variant.

Never run `happy-memory tags list`. Do not replace the native limit with client-side truncation.

## Choose Keywords

- Select stable subjects, domains, components, technologies, or cross-cutting concerns central to the memory.
- Include a keyword only when it will improve future grouping or filtering.
- Use the smallest sufficient mix of broad grouping tags and discriminative
  specific tags.
- Allow a specific tag to begin on one memory when it names a stable durable
  category; frequency is not a prerequisite.
- Avoid near-duplicate synonyms, overly general words, incidental details, and
  tags that compensate for unclear text.
- Keep tags aligned with the current atomic content.
- Recompute tags independently for each memory produced by a split.

Ensure essential retrieval terms also occur naturally in the title or content
because tag filters cannot satisfy the required textual query.

## Maintain Associations

When updating:

1. Start from the complete current canonical tag set.
2. Preserve every association that still describes the current content.
3. Add resolved keywords that became relevant.
4. Remove associations that no longer describe the content.
5. Send the complete desired set when the `tags` patch member is present.

Use `tags: []` only when no keyword remains applicable.

## Create Vocabulary Carefully

Create a new tag only when bounded searches find no adequate canonical tag. Supply a concise description only when the scope is clear. Remember that the CLI preserves the first description and does not directly rename, merge, edit, or delete vocabulary records.
