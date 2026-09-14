# ADR-0019: Batch counters computed live, not trusted from storage

_Status: accepted · Date: 2026-09 (v1.5.0 labeller, refined v1.7.0)_

## Context

The import progress UI shows rows imported/duplicated/updated and labels
done/failed/total. Rows can be **re-pointed between batches** (fuzzy
upgrades) and **reset to pending** (label deletion, retry, rule apply) after
the counters were recorded — stored counts drift immediately.

## Decision

Label progress is **computed per read** from live row ownership:
`computeLabelCounters()` runs `COUNT(*) FILTER (WHERE …)` grouped by
`label_status` over the batch's booked rows (`lib/import/counters.ts`),
so the invariant `done + failed + pending('Gebucht') = total` holds by
construction. The stored `labels_*` columns exist for history display but
read paths for active batches use the live query
(`withLabelCounters()`).

## Alternatives considered

- **Trust stored counters** — cheapest read, wrong under re-pointing and
  resets; the UI would show stale/wrong numbers exactly when it matters.
- **Trigger-maintained counters** — SQLite triggers add hidden write logic;
  the COUNT queries are cheap at this data volume.

## Consequences

- Positive: progress never drifts; no counter-update code paths to forget.
- Negative: a few aggregate queries per poll (1 Hz on one batch) — negligible
  with the `label_status`/`batch_id` indexes.
