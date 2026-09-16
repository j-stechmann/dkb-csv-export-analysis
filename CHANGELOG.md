# Changelog

## v1.9.1

### Fixed

- `GET /api/labels` reported wrong `ruleCount` values (usually 0): the
  correlated subquery's unqualified `"id"` resolved to the inner
  `label_rules.id` instead of the outer `categories.id` (SQLite column
  shadowing). The reference is now table-qualified, and a regression test
  seeds two rules to catch any future masking.

## v1.9.0

### Changed

- Git-flow is now in place: `develop` is the integration branch for all work
  (features, fixes, Dependabot PRs); `master` holds only released code.
  See `CONTRIBUTING.md`.

### Added

- Categories now have **permanent, unique** colors, stored in a new
  `categories.color` column (unique index). Colors are allocated at creation
  (curated 12-color oklch palette first, then procedural unique colors) and
  backfilled deterministically for existing DBs on startup. The chart, table
  badges, filter dots, and label lists all render the stored color; the old
  id-hash remains only as a legacy fallback.

## v1.8.0

### Breaking

- Label rules are now keyed on the strict triple (payer, payee, counterparty IBAN) instead of (IBAN, name key). The `label_rules` table is rebuilt on startup, which **discards all previously learned rules**. Rules regenerate automatically as labels are re-assigned; there is no other visible signal of the loss.
