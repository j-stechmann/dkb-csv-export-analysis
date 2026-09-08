# ADR-0022: Balance back-calculation from snapshot anchors; time-scoped-only balance/savings

_Status: accepted · Date: 2026-08 (initial commits), refined v1.2.0_

## Context

DKB exports carry one `Kontostand` snapshot at the _end_ of the export
period — there are no per-transaction running balances. The UI needs a daily
balance timeline and a 6-month savings history that stay correct as new
exports arrive.

## Decision

[lib/analytics/engine.ts](../../lib/analytics/engine.ts):

- **Back-calculation**: take the latest snapshot across import batches as
  the anchor; earlier days are computed as `balance(d) = anchor − Σ(bookings
in (d, anchorDate])` (suffix accumulation), later days accumulate forward.
  No snapshot → cumulative sum from zero, flagged in the response.
- **Time-scoped only**: balance and savings history strip content filters
  (text, type, category, label status) and keep only time/account scoping —
  cumulative quantities are meaningless under content filters (the anchor
  includes all transactions). The KPI balance reads the _unfiltered_ series
  so an empty visible window still yields a value.
- Averages/savings rate use **full months only** (partial current month and
  partial boundary months excluded); savings history separates the running
  month as a distinct, dashed series with a staleness flag.

## Alternatives considered

- **Per-transaction running balance column** — denormalized, breaks when
  reconciliation re-points rows; back-calculation stays derived and cheap.
- **Honor content filters anyway** — would produce wrong "balances"
  (suffix math over a filtered subset), the most misleading failure a
  finance chart can have.

## Consequences

- Positive: balance is exact at the anchor and consistent elsewhere; one
  implementation serves charts and KPIs; documented, testable scoping
  rules ("why doesn't the chart match my filter?" has a principled answer).
- Negative: users must learn that balance/savings ignore content filters —
  surfaced in the UI (dashed running month) and docs.
