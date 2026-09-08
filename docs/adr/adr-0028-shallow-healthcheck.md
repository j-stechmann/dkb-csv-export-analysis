# ADR-0028: Shallow, liveness-only container healthcheck

_Status: accepted · Date: 2026-08 (pre-v1.0.0)_

## Context

The container needs a Docker `HEALTHCHECK`, but the app's real dependencies
(llama-server, database schema) can be temporarily unavailable without the
app being broken — restarts would make things worse, not better.

## Decision

The healthcheck probes **`/api/llm/health` only as an HTTP liveness signal**:
that route always returns 200 (the LLM status lives in the _body_, and DB
status is not checked). An external llama-server outage or a misconfigured
`DATABASE_PATH` therefore never marks the container unhealthy. Related:
schema setup in instrumentation only logs failures instead of crashing
startup — DB readiness is not covered by probes or `--start-period`.

## Alternatives considered

- **Deep healthcheck (LLM + DB in the status code)** — an LLM outage would
  mark the container unhealthy and (with orchestrators) trigger restart
  loops of a perfectly working app.
- **No healthcheck** — loses the cheap "is the HTTP server alive" signal for
  `docker ps` and compose tooling.

## Consequences

- Positive: restart storms are impossible; degradation (no LLM) is visible
  in the UI badge, not punished with restarts.
- Negative: `unhealthy` strictly means "HTTP layer dead" — operators must
  read the badge/logs for dependency state (documented in
  [operations.md](../operations.md)).
