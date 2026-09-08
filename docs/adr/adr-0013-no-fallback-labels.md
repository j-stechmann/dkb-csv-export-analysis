# ADR-0013: No fallback labels — explicit `failed` state

_Status: accepted · Date: 2026-09 (v1.5.0 labeller)_

## Context

When the LLM cannot (or does not) produce a usable label, the system needs a
policy. Common designs pick a generic fallback category ("Sonstiges") to keep
rows out of the "unlabeled" bucket.

## Decision

**There are no fallback labels.** Rows the model could not label (timeouts,
garbage output, exhausted attempts) end up `label_status = 'failed'` — shown
as "ohne Kategorie" — and are retried on their next claimable tick or via the
retry button. Timeouts are never retried inside the client (a deterministic
truncation would burn every attempt identically); transient errors get a
small retry budget ([labelling.md](../labelling.md)).

## Alternatives considered

- **Generic fallback category** — hides failures, pollutes category stats
  (analytics count "Sonstiges" as if it were information), and disincentivizes
  fixing the root cause.
- **Leave pending forever** — wedges batch drain detection and misleads the
  progress UI.

## Consequences

- Positive: analytics never contain fabricated categories; failure is visible
  and actionable; the invariant is simple to test.
- Negative: the UI must make "ohne Kategorie" look intentional (it does —
  with a retry path) rather than broken.
