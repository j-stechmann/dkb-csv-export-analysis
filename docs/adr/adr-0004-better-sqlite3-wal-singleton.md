# ADR-0004: better-sqlite3 + WAL + synchronous singleton (drizzle as query builder)

_Status: accepted · Date: 2026-08 (initial commits)_

## Context

The app needs transactional storage for transactions, batches, labels, and
rules; it is a single-process local tool with modest data volume (thousands
of rows), and it runs background jobs in the same process as the API.

## Decision

**SQLite via better-sqlite3**, opened once per process as a module singleton
cached on `globalThis`, with `journal_mode = WAL`, `foreign_keys = ON`, and
`busy_timeout = 5000`. **Drizzle-orm is used only as a type-safe query
builder** over it — there are no drizzle-kit migrations
([ADR-0005](adr-0005-code-first-ddl.md)).

`getDb()` additionally re-runs `migrateSchema()` on every call (cheap,
idempotent) so dev hot-reloads heal a file DB whose schema changed, and
branches on `process.env.VITEST` to return an injected in-memory test DB.

## Alternatives considered

- **Postgres/MySQL** — needs a server, overkill for a local single-user app,
  complicates Docker (a second container or an embedded server).
- **ORM with migrations (drizzle-kit generate/migrate)** — a migration folder
  and CLI step for a schema that changes rarely; the hand-written idempotent
  DDL + introspection-based healing is less machinery and hot-reload-safe.
- **Multiple connections / pool** — better-sqlite3 is synchronous and fast;
  one handle per process avoids cross-connection write contention (WAL +
  busy_timeout cover the rest).

## Consequences

- Positive: zero-admin storage, transactional integrity for the tricky
  label/rule/batch flows, native speed, trivial backup (copy one directory).
- Negative: the native addon constrains the build (glibc-matching base image,
  prebuild tracing — see [ADR-0027](adr-0027-docker-posture.md)) and blocks
  any Edge-runtime usage (the instrumentation guard exists for this).
- Neutral: TEXT ISO timestamps instead of epoch integers (sortable,
  debuggable, `substr`-able for month grouping).
