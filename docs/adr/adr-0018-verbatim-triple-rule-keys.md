# ADR-0018: Verbatim (payer, payee, counterparty IBAN) triple rule keys

_Status: accepted · Date: 2026-09 (v1.8.0, supersedes the v1.5.0 (IBAN, name-key) shape)_

## Context

Learned rules suggest labels for recurring counterparties. The v1.5.0 shape
keyed rules on `(counterparty IBAN, label name-key)`, which misfired: the
same IBAN is used for multiple purposes (a person's account receives salary
and sends rent), producing wrong suggestions, while the label-name half of
the key coupled suggestions to a specific label.

## Decision

[v1.8.0](../../CHANGELOG.md): rules are keyed on the strict, **verbatim**
triple `(payer, payee, counterparty_iban)` → `label_id`
([lib/labels/matching.ts](../../lib/labels/matching.ts)):

- Values are stored and compared exactly as the CSV parser normalized them —
  **no additional normalization** (the transaction fields were already
  whitespace-normalized at parse time; label _names_ have their own
  `nameKey` normalization — deliberately different layers).
- A unique index on the triple makes "at most one rule per key" true by
  construction; re-learning for a new label replaces the rule (newest wins).
- Matching is exact SQL equality (which also excludes NULLs); the batch
  variant dedupes queries by triple.

## Alternatives considered

- **Fuzzy/normalized matching (lowercased, tokenized)** — more hits, but
  wrong suggestions are worse than missing ones; verbatim keys make behavior
  predictable and debuggable.
- **IBAN-only keys** — the original mistake; one IBAN ≠ one purpose.

## Consequences

- Positive: suggestions only fire for structurally identical
  counterparty triples; the LLM still confirms (suggestions are advisory in
  the prompt).
- Negative: **breaking change** — the table was rebuilt on startup and old
  rules discarded (they regenerate from re-assignment); rules with missing
  IBANs can't exist (all three fields must be non-empty).
