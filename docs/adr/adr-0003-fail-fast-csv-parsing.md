# ADR-0003: Fail-fast CSV parsing with header-name mapping

_Status: accepted · Date: 2026-08 (initial commits)_

## Context

DKB CSV exports vary: BOM presence, quoted multi-line purposes, padded
trailing columns, reordered or renamed headers, placeholder rows
(`DD.MM.YY`, "Beispiel-IBAN hier"). A lenient parser would import garbage
rows; a position-based mapper breaks when DKB reorders columns.

## Decision

[lib/csv/parser.ts](../../lib/csv/parser.ts):

- **Fail fast**: the first unparseable data row aborts the whole import with
  a row-numbered error. Full retention makes lenient parsing unrecoverable —
  half an import cannot be reconciled meaningfully.
- **Header-name mapping, not position**: all 12 German headers are required;
  columns are located by exact header cell match (never raw line search —
  quoted preamble fields could contain the marker text).
- **Preamble parsing** for account identity and the `Kontostand` snapshot;
  the `Zeitraum` row is deliberately ignored (unreliable format).
- **Pre-write validation**: `peekDkbCsvAccount()` does a synchronous 10-row
  scan in the upload route _before any DB write_, so a bad file creates no
  orphan rows ([csv-import.md](../csv-import.md)).
- Sign consistency is validated (`Ausgang` must be negative, `Eingang`
  positive); cells are whitespace-normalized (NFC, NBSP collapse) for
  hashing and payload.

PapaParse was chosen for proven RFC-4180 handling (quoted multi-line fields)
with `header: false` so the preamble and header mapping stay under our
control.

## Alternatives considered

- **Lenient parsing with a skipped-rows report** — friendlier for messy
  files, but partial imports violate the "transactions never deleted /
  analytics exact" invariants.
- **Positional column mapping** — less code, breaks on format variations.

## Consequences

- Positive: no partial imports ever; format variations are absorbed by
  header mapping; the fixture suite pins the exact behavior.
- Negative: one odd row blocks an otherwise fine file — acceptable for a
  personal-finance tool where the file can be fixed locally.
