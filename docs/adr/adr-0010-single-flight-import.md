# ADR-0010: Single-flight import job with 202 + client polling

_Status: accepted · Date: 2026-08 (initial commits)_

## Context

CSV parsing + reconciliation + dedupe take seconds; the upload route must
return fast, concurrent imports must be impossible (they would race the
reconcile stage), and the UI needs progress.

## Decision

`POST /api/imports` validates synchronously (size ≤ 25 MB, preamble peek
before any DB write) and returns **202 with `batchId`** while the heavy work
runs as a fire-and-forget promise:

- **Single-flight**: `globalThis.__dkbImportJob` is claimed _before_ the job
  body runs (the body executes synchronously — no awaits — so setting the
  flag afterwards would leave it stuck on true); a concurrent upload gets
  **409 `import_in_progress`**. The flag resets in `.finally()`.
- **Startup recovery**: batches stuck in `parsing`/`importing` after a
  restart are marked `failed` ("interrupted by server restart");
  `labeling` batches are deliberately excluded — their rows persist and the
  label worker resumes them ([ADR-0011](adr-0011-startup-recovery.md)).
- **Progress**: the client polls `GET /api/imports/[id]` at 1 Hz (only while
  non-terminal); counters are computed live from rows
  ([ADR-0019](adr-0019-live-batch-counters.md)).

## Alternatives considered

- **Await the whole import in the request** — exceeds sane HTTP timeouts for
  large files; no progress.
- **A job queue table + polling worker** — more state for a single-user app
  where "one import at a time" is the natural contract.

## Consequences

- Positive: instant feedback, atomic imports, no race between overlapping
  uploads, self-healing after crashes.
- Negative: fire-and-forget means the client must poll (mitigated by the 1 Hz
  conditional polling) and a server crash loses in-flight work (mitigated by
  recovery + idempotent re-import).
