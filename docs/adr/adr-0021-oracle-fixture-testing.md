# ADR-0021: Oracle testing via generated fixture + KPI manifest

_Status: accepted · Date: 2026-08 (initial commits)_

## Context

Analytics correctness ("does the savings rate really match the data?") is
hard to assert with hand-written examples for 24 months of data — and hand-
maintaining hundreds of CSV rows is worse.

## Decision

[scripts/generate-fixture.ts](../../scripts/generate-fixture.ts) generates a
deterministic 24-month DKB export from explicit row specs (salary, rent,
groceries, an identical same-day pair for occurrence dedupe, a multi-line
quoted purpose, pending rows, zero-amount rows, a >512-char purpose for
truncation testing) **and** computes the expected KPI manifest from the same
specs — a second, independent implementation. The integration test
([tests/fixture-integration.test.ts](../../tests/fixture-integration.test.ts))
runs the real pipeline and asserts every KPI **to the cent**: balance,
averages, savings rate, monthly cashflow, top categories, plus the
back-calculated balance timeline and date-window semantics. Tests also use
raw-SQL oracles against the same DB as an independent check. A second
fixture covers reconciliation counts (upgrades/skips/duplicates/inserts) and
February day-clamping.

## Alternatives considered

- **Golden/snapshot tests** — assert what the code does, not what it should
  do; they greenlight regressions that change outputs consistently.
- **Randomized end-to-end runs** — non-reproducible failures; the manifest
  approach keeps determinism.

## Consequences

- Positive: to-the-cent guarantees over the full pipeline; the manifest
  doubles as executable documentation of the KPI formulas.
- Negative: the generator is a second implementation to keep correct
  (deliberately — disagreement between the two is exactly what tests should
  catch).
