# ADR-0011: Startup recovery semantics (stuck-batch reset excludes labeling)

_Status: accepted · Date: 2026-08 (initial commits)_

## Context

A crash or restart can leave `import_batches` rows in non-terminal states.
Naive recovery ("fail anything non-terminal") would cancel labeling work that
is actually resumable.

## Decision

At server boot ([instrumentation-node.ts](../../instrumentation-node.ts)), after
`ensureSchema()`:

- Batches in `parsing` or `importing` → marked `failed` with error
  "interrupted by server restart". Their work is not resumable (the temp CSV
  is gone).
- Batches in `labeling` → **left untouched**. Transactions persist; the label
  worker's drain detection re-completes these batches on its first ticks
  ([labelling.md](../labelling.md)).
- Recovery happens **before** `startLabelWorker()` so the worker never sees a
  half-recovered state, and `startLabelWorker()` is idempotent via
  `globalThis.__dkbLabellerWorkerStarted`.

## Alternatives considered

- **Fail all non-terminal batches** — would reset labeling progress for
  hours of LLM work after every dev restart.
- **Resume imports by persisting the CSV** — extra storage and cleanup for a
  rare case; re-importing is idempotent (ADR-0006) and cheaper.

## Consequences

- Positive: restarts are cheap and predictable; no labeling work is lost.
- Negative: users must re-import CSVs for interrupted imports (one drag-drop;
  dedupe makes it a no-op for already-stored rows).
