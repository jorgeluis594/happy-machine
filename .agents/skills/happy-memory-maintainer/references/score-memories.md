# Score Memories

Assign required importance and confidence values independently after defining the atomic memory's current title and content.

Score only after the candidate satisfies the durable-memory boundary. Importance and confidence describe a qualifying memory; neither is an admission threshold, and a low value does not independently justify discarding it.

## Assign Importance

Measure the future impact of forgetting the information:

1. **Minimal:** The utility is highly localized; forgetting it would have negligible consequences.
2. **Low:** It can save work in limited situations and is easy to rediscover.
3. **Medium:** It materially influences future work; forgetting it can cause rework or poor decisions.
4. **High:** It substantially affects correctness, design, or operation; forgetting it creates significant cost or risk.
5. **Critical:** It conditions fundamental project behavior; forgetting it can cause severe consequences or violate an essential rule.

## Assign Confidence

Measure the reliability and current validity of the stored assertion:

1. **Speculative:** A reasonable possibility exists, but evidence is absent or materially conflicting.
2. **Weak:** Evidence is partial, indirect, or not yet confirmed.
3. **Moderate:** Evidence is credible but incomplete, context-limited, or missing a relevant verification.
4. **High:** Reliable sources directly support the assertion, with only minor residual uncertainty.
5. **Confirmed:** Authoritative, verifiable, current evidence supports the assertion without a known material conflict.

## Apply the Scales

- Judge importance by the consequence of forgetting, not by evidence quantity.
- Judge confidence by evidence and currency, not by impact.
- Lower confidence for ambiguity without automatically lowering importance.
- Make uncertainty explicit in the stored assertion; low confidence does not make unsupported speculation presented as fact acceptable.
- Split content when its parts need different scores.
- Re-score on update only when evidence, currency, or future impact changes.
- Score the rewritten current assertion when marking previous knowledge obsolete.
- Select the best matching description directly; do not average or calculate a score.
- Never inflate either value to manipulate retrieval ranking.

Allow any importance level to coexist with any confidence level.
