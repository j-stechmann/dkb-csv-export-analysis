# ADR-0025: Manual API validation; zod reserved for environment config

_Status: accepted · Date: 2026-08 (initial commits)_

## Context

Route handlers need input validation (bodies, query params, dynamic
segments) and error mapping (400/404/409). zod is already a dependency for
env config.

## Decision

API input validation is **hand-rolled per handler**: typed narrowing
(`typeof body?.x === "string"`), allow-lists for enum-ish query params,
explicit clamps (`pageSize ≤ 100`), advisory pre-checks plus unique-constraint
catches for conflicts, and typed error responses
(`{ "error": "…" }`). **zod is used only in `lib/config.ts`** for the
environment schema (coercion, bounds, defaults, one joined error message).

All handlers pin `runtime = "nodejs"` and `dynamic = "force-dynamic"`
(better-sqlite3 is Node-only; no request caching ever), and use the Next 16
awaited-`params` convention.

## Alternatives considered

- **zod everywhere** — consistency, but the API surface is ~20 small
  handlers with a handful of fields; hand-rolled narrowing is shorter than
  schemas plus error mapping, and error messages stay hand-controlled
  (German UI copy depends on them).
- **tRPC** — replaces the REST layer wholesale; the REST shape is also
  consumed by plain fetch calls and is easier to debug with curl.

## Consequences

- Positive: zero abstraction over ~20 handlers; predictable, human-written
  error semantics; env validation stays strict and centralized.
- Negative: validation discipline is on the author of each handler (a test
  asserts the 400/404/409 mapping per route); duplicated small checks across
  handlers are possible.
