# ADR-0008: In-process background workers via globalThis singletons

_Status: accepted · Date: 2026-08 (initial commits)_

## Context

Imports must run in the background (the upload returns 202 immediately) and
labeling must run continuously; the app is a single-process local tool with
no infrastructure budget (no Redis, no worker containers), and Next.js dev
hot-reloads would start duplicate workers if state lived in module scope.

## Decision

Both background jobs live **in the Next.js Node process**, guarded and
discovered via `globalThis`:

- Import job: fire-and-forget promise with a single-flight flag
  (`globalThis.__dkbImportJob`) — [ADR-0010](adr-0010-single-flight-import.md).
- Label worker: `setInterval(tick, 3000)` + initial `setTimeout`, both
  `.unref()`ed, re-entry guard + `globalThis.__dkbLabellerWorkerStarted`,
  started from instrumentation ([ADR-0009](adr-0009-worker-reliability-protocol.md)
  covers the protocol details).
- The worker reads the import flag directly to skip ticks while an import
  runs (no interleaving of reconcile and labeling).

`instrumentation.ts` gates on `NEXT_RUNTIME === "nodejs"` and dynamically
imports the Node-only instrumentation so **the Edge bundle never touches
better-sqlite3**.

## Alternatives considered

- **External worker process + queue** — real isolation, but IPC, deployment,
  and observability costs for a single-user tool are not justified; SQLite
  writes are fast enough that a 3 s cadence keeps labels within seconds of
  an import.
- **Cron/systemd outside the app** — splits deployment into more moving
  parts; the app must be self-contained in Docker.

## Consequences

- Positive: one artifact, one process, zero infrastructure; hot-reload-safe;
  timers never hold the process open.
- Negative: LLM waits and DB work share the event loop with the UI API —
  bounded by batch size, health gate, and synchronous fast SQLite access; a
  crash in the process kills both UI and workers (mitigated by startup
  recovery, [ADR-0011](adr-0011-startup-recovery.md)).
