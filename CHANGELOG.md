# Changelog

## Unreleased

### Changed
- Git-flow is now in place: `develop` is the integration branch for all work
  (features, fixes, Dependabot PRs); `master` holds only released code.
  See `CONTRIBUTING.md`.

## v1.8.0

### Breaking
- Label rules are now keyed on the strict triple (payer, payee, counterparty IBAN) instead of (IBAN, name key). The `label_rules` table is rebuilt on startup, which **discards all previously learned rules**. Rules regenerate automatically as labels are re-assigned; there is no other visible signal of the loss.
