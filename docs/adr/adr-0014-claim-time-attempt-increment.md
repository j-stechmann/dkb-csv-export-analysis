# ADR-0014: Attempt increment at claim time + attempts-snapshot guards

_Status: accepted · Date: 2026-09 (v1.5.0 labeller)_

## Context

Between claiming rows and writing LLM results, other actors can touch the
same rows: manual label assignment, the retry endpoint, fuzzy re-pointing
from a concurrent import. Naive writes would clobber those actions or apply
stale results.

## Decision

Two coordinated mechanisms ([lib/labeller/worker.ts](../../lib/labeller/worker.ts),
[service.ts](../../lib/labeller/service.ts)):

1. **Increment `label_attempts` at claim time** (atomic `UPDATE …
RETURNING`), not at failure time. Status is untouched until results are
   written — a crash between claim and write just means the row retries next
   tick within the attempts cap.
2. **Attempts snapshot**: the claimed `Map<id, attempts>` is checked at
   apply/fail time; rows whose attempts changed since claim are skipped —
   the concurrent manual action wins over in-flight LLM results.

Related guards in the same layer: `markRowsFailed()` never flips already
labeled rows; `applyLabelResults()` runs in one transaction and resets
attempts to 0 on success.

## Alternatives considered

- **Increment on failure** — crashes between claim and write leak free
  retries forever (unbounded loop on poison rows).
- **Optimistic version column on transactions** — equivalent power, more
  schema; attempts already exist for budget accounting.

## Consequences

- Positive: crash safety and manual-action priority with zero additional
  schema; testable determinism.
- Negative: "attempts" does double duty (budget + fencing) — the semantics
  are documented in the labelling guide and pinned by tests.
