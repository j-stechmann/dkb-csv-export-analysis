# ADR-0007: Fuzzy ±7-day reconciliation with deterministic greedy matching

_Status: accepted · Date: 2026-08 (initial commits)_

## Context

DKB's export lifecycle moves rows: pending (`Nicht gebucht`) bookings
re-export as booked (`Gebucht`) a few days later, sometimes with changed
content; DKB also re-renders payee names between export formats. Plain
content dedupe (ADR-0006) cannot see these as the same transaction.

## Decision

[lib/db/match.ts](../../lib/db/match.ts) classifies incoming rows against
the DB **inside the import transaction** with:

- **Viability**: same type, same amount, same party identity (equal non-empty
  `counterparty_iban`, else `creditor_id`, else `mandate_ref`), and date
  difference ≤ `MATCH_WINDOW_DAYS = 7`.
- **Kinds**: `upgrade` (incoming booked ↔ DB pending → update in place),
  `skip` (incoming pending ↔ DB booked → drop), `refresh` (pending ↔ pending
  with changed content → update).
- **Deterministic greedy 1:1 pairing**: sort by smallest date difference →
  kind rank (upgrade < skip < refresh) → earliest booking date → ids.
- **Booked↔booked self-heal**: same `Kundenreferenz` + amount + type +
  exact booking date, differing content → keep the newest, delete the older
  (the Kundenreferenz is a generic per-contract reference for recurring SEPA
  debits, so the booking date must be part of the identity).
- Upgraded/refreshed rows get a fresh hash + occurrence slot and are
  re-pointed to the new batch; the counter invariant
  `imported + duplicates + updated === total` is asserted per import.

## Alternatives considered

- **Only exact dedupe** — pending rows would duplicate forever as they
  become booked.
- **LLM-based matching** — non-deterministic, expensive, unnecessary: bank
  fields already carry identity.
- **Wider windows / fuzzy amounts** — raises false-positive upgrade risk;
  7 days and exact amounts fit observed DKB behavior.

## Consequences

- Positive: one transaction per real-world booking across export formats;
  deterministic, testable; label state survives upgrades (in-place update).
- Negative: the matcher is subtle (642-line test file); a wrong identity
  chain would merge unrelated rows — mitigated by requiring non-empty
  identity fields and exact amounts.
