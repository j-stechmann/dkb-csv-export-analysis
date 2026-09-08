# ADR-0005: Code-first idempotent DDL + hot-reload healing (no migration files)

_Status: accepted · Date: 2026-08 (initial commits)_

## Context

The schema evolves (v1.8.0 re-keyed `label_rules` entirely), the app runs
under Next.js dev hot-reloads, and there is no ops person to run migration
commands — a Docker container starts cold and must be self-sufficient.

## Decision

Two functions in [lib/db/index.ts](../../lib/db/index.ts) replace a migration
system:

1. **`createSchemaSqlite()`** — pure `CREATE TABLE IF NOT EXISTS` /
   `CREATE INDEX IF NOT EXISTS` DDL mirroring the drizzle schema exactly
   ("drizzle-kit push equivalent, code-first").
2. **`migrateSchema()`** — `PRAGMA table_info` introspection + conditional
   `ALTER TABLE ADD COLUMN` for columns added to existing tables, plus the
   destructive `label_rules` shape rebuild. **Re-checked on every `getDb()`
   call** so a hot-reloaded singleton heals the file DB without a restart.

For breaking shape changes, drop-and-recreate is acceptable when the data is
cheap: v1.8.0 discarded old learned rules because they regenerate from user
behavior — the alternative (a data-mapping migration path) costs more than
the data. The drizzle `check()` definitions exist only for drizzle-kit push
parity and must stay in sync with the DDL.

## Alternatives considered

- **drizzle-kit generate/migrate** — versioned SQL files; adds a CLI step,
  needs a migrations table, and doesn't compose with hot-reload healing.
- **Never change existing tables** — unrealistic; `origin`/`usage_count`
  were added within weeks.

## Consequences

- Positive: fresh boots always match the code; dev DBs self-heal; no
  migration discipline to maintain.
- Negative: destructive migrations must be justified per-case (data loss);
  the DDL ↔ drizzle-schema duality is a drift surface (guarded by tests
  asserting the rebuilt schema).
