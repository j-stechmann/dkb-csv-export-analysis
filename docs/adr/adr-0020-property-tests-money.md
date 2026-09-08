# ADR-0020: Property-based tests only for money parsing; oracle fixtures for everything else

_Status: accepted · Date: 2026-08–09_

## Context

The test suite must prove two different things: (a) the money parser handles
_arbitrary_ German-format inputs correctly, and (b) the analytics pipeline
computes _specific_ KPIs exactly. Property-based testing everywhere would be
slow and produce non-reproducible failures; pure example testing would
under-cover the parser.

## Decision

- **Property-based (fast-check) only for money**
  ([tests/money.test.ts](../../tests/money.test.ts)): a 10,000-case round-trip
  `cents → formatCentsAsGerman → parseGermanAmountToCents ≡ identity` plus a
  second property over explicitly constructed German strings, with one
  documented exception (`-0,00` — negative zero is not a meaningful amount).
- **Oracle fixtures for the pipeline**
  ([scripts/generate-fixture.ts](../../scripts/generate-fixture.ts)): a
  deterministic 24-month synthetic export plus a hand-computed KPI manifest —
  a second, independent implementation of the analytics — asserted to the
  cent through the real code path (see [testing.md](../testing.md),
  [ADR-0021](adr-0021-oracle-fixture-testing.md)). A seeded LCG exists in the
  generator but is deliberately unused.

## Alternatives considered

- **Property tests for analytics** — requires an oracle anyway; the fixture
  manifest _is_ the oracle, deterministic and reviewable.
- **Snapshot tests** — encode implementation output, not correctness.

## Consequences

- Positive: exhaustive coverage exactly where inputs are unbounded (money);
  reproducible, reviewable failures everywhere else.
- Negative: two test styles to understand; fixture regeneration must stay in
  sync with the manifest by construction (the generator computes both).
