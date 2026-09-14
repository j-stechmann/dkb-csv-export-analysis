# ADR-0009: In-process worker reliability protocol (claim-time attempts, health gate, drain detection)

_Status: accepted · Date: 2026-09 (v1.5.0 labeller)_

## Context

The labeling worker must survive crashes between "claim" and "write", LLM
outages, concurrent manual label edits, and attempt exhaustion — without a
queue to lean on.

## Decision

A three-part protocol ([lib/labeller/worker.ts](../../lib/labeller/worker.ts),
[service.ts](../../lib/labeller/service.ts)):

1. **Claim-time attempt increment**: `claimLabelRows()` atomically increments
   `label_attempts` via `UPDATE … RETURNING` but flips no status — a crash
   between claim and write is safe (the row retries next tick until the
   cap). The claimed attempts are snapshotted; apply/fail paths skip rows
   whose attempts changed since claim — **manual actions win over in-flight
   LLM results**.
2. **Health gate**: every tick probes `GET /health` (5 s timeout) and skips
   unless `ok` — an LLM outage cannot burn attempt budgets on timed-out
   claims ([ADR-0015](adr-0015-health-gate.md)).
3. **Drain detection without the LLM**: batches complete when no row is
   `Gebucht + pending + attempts < cap` — covering all-pending batches,
   failed rows, and attempt-exhausted rows (the retry endpoint revives those
   with a fresh budget).

**No fallback labels**: rows the model could not label become explicitly
`failed` ("ohne Kategorie") — never a guessed category
([ADR-0013](adr-0013-no-fallback-labels.md)).

## Alternatives considered

- **Status-flipping claim (`pending → processing`)** — classic queue design,
  but requires stuck-state recovery and complicates concurrent manual edits;
  the attempts counter achieves the same crash safety with less state.
- **Retry inside the worker on failure** — already covered: failed rows are
  re-claimable next tick; a per-request retry budget exists in the client
  for transient errors only.

## Consequences

- Positive: crash-safe without a queue; concurrent manual edits are never
  clobbered; outages are cheap (gate) instead of destructive (burned
  budgets).
- Negative: attempt semantics are subtle (increment at claim, reset on
  success) — pinned by dedicated tests; exhausted rows need the explicit
  retry path.
