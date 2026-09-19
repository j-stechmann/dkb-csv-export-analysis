# ADR-0032: Multi-user OIDC authentication with per-user data isolation

_Status: accepted · Date: 2026-09 (v2.0) · **Supersedes the no-auth decision of
[ADR-0031](adr-0031-no-auth-local-first-privacy.md)** (its data-locality
privacy posture remains in force)_

## Context

ADR-0031 chose "no auth" for a single-user, local-first tool and warned that
the posture fails silently if the app is reverse-proxied to a network. The
product direction changed: the app is now deployed behind a reverse proxy for
**multiple users**, each of whom must see only their own bank data. "Handles
bank data" now decisively outweighs "zero-config local tool".

## Decision

**Mandatory OIDC authentication** (generic provider via issuer discovery —
Keycloak, Authentik, Authelia, Pocket ID, …) plus **per-user data isolation**:

- **Auth stack**: `openid-client` (certified OIDC client, 2 deps) +
  `jose`-signed HS256 session cookie (httpOnly, SameSite=Lax). No
  framework-coupled auth library; ~6 small files under `lib/auth/` +
  `app/auth/`.
- **Login flow**: authorization-code + PKCE (S256) + state + nonce; state/
  verifier/nonce ride in short-lived HttpOnly cookies. `proxy.ts` (Next 16's
  renamed middleware convention) gates every path except `/auth/*`,
  `/api/llm/health` (Docker HEALTHCHECK, [ADR-0028]) and static assets:
  pages redirect to `/auth/login`, `/api/*` gets `401 {"error":"unauthorized"}`.
- **Users**: JIT-provisioned on first login, keyed on `(issuer, subject)`.
  No allowlist — whoever the provider lets through gets a workspace. The
  provider is trusted to gate identities.
- **Isolation**: `users.id` is stamped on `accounts`, `import_batches`,
  `categories`, `label_rules`, `transactions` (denormalized on transactions
  for single-`WHERE` analytics). Every query, route handler, import job and
  worker claim is user-scoped; learned label rules are per user (the LLM only
  sees the owner's rules and label vocabulary). Account uniqueness moved from
  `iban` to `(user_id, iban)`: two users importing the same IBAN get fully
  separate copies.
- **Migration (fresh start)**: pre-user tables cannot be attributed to an
  owner, so the v1→v2 migration drops them (`dropLegacyUserlessTables`) and
  recreates user-shaped tables — same destructive-migration rationale as
  ADR-0005's `label_rules` rebuild. Users start empty; imports regenerate the
  data.
- **Env config** (fail-fast at startup via the existing zod schema):
  `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` required;
  `OIDC_SCOPES`, `SESSION_TTL_SECONDS`, `SESSION_SECRET` (falls back to the
  client secret), `APP_ORIGIN` optional.

## Alternatives considered

- **Auth.js (NextAuth v5 beta)** — batteries included, but beta-status and
  framework-coupled; the app's code-first ethos favored the thin wrapper.
- **SQLite-backed sessions** — revocable server-side, but adds a table to
  the DDL↔schema duality for a capability (stateless JWT expiry) the single
  process does not need; logout is cookie-clearing + optional
  `end_session_endpoint`.
- **Opt-in auth via env** — rejected: a half-authenticated posture repeats
  ADR-0031's silent-failure mode. Auth is mandatory; unconfigured env fails
  at boot.
- **Backfill legacy data to a designated owner** — rejected: implies an
  allowlist/owner notion that the multi-user design dropped, and mis-owned
  bank data is worse than empty state.

## Consequences

- Positive: network exposure is now defensible; per-user isolation is
  enforced at the query layer; learned-rule injection stays private per user.
- Negative: startup now requires a reachable-ish issuer URL config (discovery
  is lazy — the app boots without the provider online, login fails until it
  is up); zero-secret is gone (`SESSION_SECRET`); sessions are not server-side
  revocable (mitigated by short-ish TTL via `SESSION_TTL_SECONDS`).
- Neutral: the Docker HEALTHCHECK path stays unauthenticated by design
  (shallow, no data, [ADR-0028]).
- Neutral: the import single-flight lock
  ([ADR-0010](adr-0010-single-flight-import.md)) remains process-global, so
  under multi-user one user's import makes another user's upload fail with
  `409 import_in_progress` and pauses the label worker for everyone. Accepted
  for now (SQLite, single process, imports are rare and short); revisit with
  a per-user lock if concurrent imports become common.
