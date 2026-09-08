# ADR-0015: Health gate before labeling ticks

_Status: accepted · Date: 2026-09 (v1.5.0 labeller)_

## Context

The worker ticks every 3 s. Without a check, an LLM outage would claim rows
and burn their attempt budgets on timed-out requests — leaving rows
unclaimable until manual retry, turning a transient outage into data-level
damage.

## Decision

Every `tick()` calls `client.health()` — a cheap `GET /health` with a 5 s
timeout, classified `ok / degraded / unreachable` — and skips the entire tick
unless `ok`. The same probe powers `GET /api/llm/health` and the header
health badge, so users see the same state the worker acts on. Drain
detection (batch completion) still runs during outages — it needs no LLM.

## Alternatives considered

- **Circuit breaker with cooldown timers** — more state for marginal benefit;
  the probe is already cheap and the tick cadence is the natural cooldown.
- **Rely on client retries** — wrong layer: the damage (burned attempts)
  happens at claim time, before any retry logic.

## Consequences

- Positive: outages are free (rows wait, budgets intact); one source of
  health truth for worker, API, and UI.
- Negative: a flapping-but-reachable server (`degraded`) still gates ticks —
  conservative by design.
