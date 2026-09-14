# ADR-0006: Occurrence-aware content-hash dedupe (multiset union)

_Status: accepted · Date: 2026-08 (initial commits)_

## Context

Re-importing overlapping DKB exports is a first-class workflow (users export
periods repeatedly; pending rows re-appear as booked). A naive unique
constraint on content would **lose legitimate duplicate transactions** — two
identical coffees on the same day are two transactions, not one.

## Decision

[lib/db/dedupe.ts](../../lib/db/dedupe.ts):

- **Content hash**: SHA-256 over all normalized content fields (including
  both party names and all reference fields), joined with `|`, scoped to the
  account; `HASH_VERSION = 1` stored per row lets the hash shape evolve
  without invalidating old rows.
- **Multiset semantics with occurrence slots**: per hash, if the file
  contains N rows and the DB already has E, the first `min(N, E)` are
  duplicates and `N − E` are inserted at occurrence indices
  `[E, N)` (`lowestFreeIndex()`). The unique index
  `(account_id, source_hash, occurrence_index)` enforces this; inserts use
  `onConflictDoNothing`.

Re-importing the same file inserts nothing; overlapping exports insert only
the surplus; identical same-day transactions are all preserved. **Transactions
are never deleted on re-import.**

## Alternatives considered

- **Unique index on content hash alone** — simplest, but silently drops
  legitimate duplicates.
- **Fingerprint on booking date + amount only** — too coarse; same-day
  same-amount different-purpose rows would collide.
- **Delete-and-reinsert per account on re-import** — destroys label state and
  violates the never-delete invariant.

## Consequences

- Positive: idempotent imports; no data loss; dedupe is decidable row-locally.
- Negative: one more column trio (`source_hash`, `occurrence_index`,
  `hash_version`) and a composite unique index; hash changes require the
  version field to migrate coherently.
