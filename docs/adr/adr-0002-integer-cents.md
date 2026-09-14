# ADR-0002: Integer cents for all money

_Status: accepted · Date: 2026-08 (initial commits)_

## Context

DKB exports amounts in German decimal format (`1.234,56`). Any float-based
parsing or aggregation risks the classic `0.1 + 0.2` drift, and analytics
(KPIs, balance timelines, savings rates) would drift visibly at chart scale.

## Decision

**Every amount is parsed to signed integer cents and stored as
`INTEGER` (`amount_cents`).** All arithmetic — aggregation, back-calculation,
averages — happens in integer space; conversion to display strings happens
only at the edges (`formatCentsAsGerman()`, `toLocaleString("de-DE")` in the
UI).

The parser ([lib/money.ts](../../lib/money.ts)) implements exact
disambiguation rules for German formats (thousands vs decimal separators,
trailing minus, NBSP handling) and rejects anything ambiguous or sub-cent;
the result must be a `Number.isSafeInteger`.

## Alternatives considered

- **Floats / decimal.js** — simpler parsing, but every aggregation needs
  rounding discipline; a library adds weight for two operations.
- **Store the raw string** — display-only; makes SQL aggregation and
  comparisons wrong-by-default.

## Consequences

- Positive: analytics are exact (asserted to the cent by the test suite);
  property-based round-trips prove parse/format fidelity (20k cases).
- Negative: the parser is the most rule-dense file in the codebase and the
  correctness core — every change needs test coverage.
- Neutral: sub-cent amounts are rejected by design (no real DKB export has
  them); `-0,00` normalizes to `0`.
