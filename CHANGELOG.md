# Changelog

## Unreleased

### Security

Security-audit follow-ups (threat model: a guest on the same network):

- **CSRF guard on every mutating route**: all non-GET API handlers and the
  auth endpoints now share `assertSameOrigin` (lib/auth/guard.ts) —
  `Origin`/`Sec-Fetch-Site` must match the app origin or the request gets
  `403 {"error":"cross_site_request_rejected"}`. Closes the same-site
  cross-origin gap that `SameSite=Lax` alone leaves open. `/auth/logout` was
  refactored onto the same helper (error code renamed from
  `cross_site_logout_rejected`). Note this is fail-closed: a reverse-proxied
  deployment without `APP_ORIGIN` now gets 403 on every mutating call (the
  internal origin can never match the browser's public Origin) — previously
  only `/auth/logout` rejected such requests; set `APP_ORIGIN` when proxying.
- **Plaintext-HTTP warning at startup**: when `APP_ORIGIN` is set and not
  HTTPS the boot logs a loud warning — bank data over plain HTTP is readable
  and script-injectable by anyone on the network. Docs now state TLS is
  mandatory for any non-localhost deployment.
- **Security headers**: `Content-Security-Policy` (no cross-origin scripts,
  `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy` on all routes;
  `Cache-Control: no-store` on `/api/*` and `/auth/*`.
- **Constant-time OIDC state comparison** (`node:crypto.timingSafeEqual`) in
  `/auth/callback` instead of `===`.
- **Cookie readers hardened**: malformed percent-encoded cookie values now
  resolve to null (401/redirect) instead of throwing a 500
  (`getSession`, `cookieValue`).
- **Dev IdP hardening**: compose.dev.yaml binds Authentik to `127.0.0.1`
  only and reads credentials from the gitignored `compose.dev.env`
  (template: `compose.dev.env.example`, created on first `make oidc`) —
  previously the bootstrap password/token were committed in the compose
  file and the admin UI listened on all interfaces.
- Startup reminder to keep `data/` and `.env` owner-only on multi-user
  hosts (umask 077 / chmod 600).

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
