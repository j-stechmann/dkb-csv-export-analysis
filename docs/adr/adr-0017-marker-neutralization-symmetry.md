# ADR-0017: Marker-neutralization symmetry between prompt and stored labels

_Status: accepted · Date: 2026-09 (v1.5.0–v1.7.0 labeller hardening)_

## Context

Prompts use reserved markers (`[i]`, `<<…>>`, `|` as suggestion separator,
`index=` keys). If a _stored label_ contains such a marker, rendering it back
into a prompt is ambiguous — and worse, a label like "Miete | Nebenkosten"
would sanitize to "Miete / Nebenkosten" on reuse, failing to match its own
`nameKey` and creating a **phantom duplicate category on every reuse**.

## Decision

**Input and output share one sanitizer.** `sanitizeField()` (prompt input)
and `sanitizeLabel()` (model output) both apply `neutralizeMarkers()`:
`<<`/`>>` runs collapse to single characters **iterating to a fixed point**
(a single pass only halves odd runs — `a<<<b` → `a<<b` still reads as a
marker opener), `index=` becomes `index `, `|` becomes `/`; control
characters are dropped; labels cap at 64 UTF-8 bytes, prompt fields at 512.

Additionally, `isValidLabelName()` rejects any manual label that does not
survive `sanitizeField()` unchanged — the round-trip check **subsumes the
marker list**, so validation cannot drift if the sanitizer's rewrite set
ever changes.

## Alternatives considered

- **Escape markers instead of neutralizing** — escaping is lossy in the other
  direction (the LLM would have to un-escape correctly) and the model is the
  least reliable participant.
- **Reject marker characters everywhere** — too strict for input _fields_
  (purposes legitimately contain `|`); neutralization preserves content
  while removing ambiguity.

## Consequences

- Positive: stored labels render into prompts byte-for-byte (no phantom
  duplicates); one sanitization story for input and output.
- Negative: some cosmetic fidelity loss in label names (`|` → `/`);
  developers must reuse the shared helpers instead of ad-hoc trimming.
