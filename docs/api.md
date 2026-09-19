# API reference

_Last reviewed against v2.0. Descriptive reference — verify against `app/api/`. All 17 route files export `runtime = "nodejs"` and `dynamic = "force-dynamic"` (no request caching, ever), and use the Next 16 `params: Promise<…>` convention._

Validation is **hand-rolled per handler** with typed narrowing and typed
error responses; zod is reserved for environment config
([ADR-0025](adr/adr-0025-manual-api-validation.md)). Error bodies are
`{ "error": "machine_readable_code" }` or `{ "error": "message" }`.

## Authentication

Every endpoint (except `GET /api/llm/health`, the Docker healthcheck) requires
a valid session cookie ([ADR-0032](adr/adr-0032-multi-user-oidc.md)). The
`proxy.ts` gate returns `401 {"error":"unauthorized"}` for unauthenticated
`/api/*` requests; page requests redirect to `/auth/login`. Auth endpoints:

| Method & path        | Success                             | Errors                                                                               | Purpose                                                                                                    |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `GET /auth/login`    | 302 → OIDC provider                 | 502 `login_failed` (provider unreachable/misconfigured)                              | Starts the authorization-code flow (PKCE + state + nonce; state in HttpOnly cookie)                        |
| `GET /auth/callback` | 302 → `/` + session cookie          | 401 `provider_error` / `exchange_failed`; state mismatch → restart via `/auth/login` | Verifies state (constant-time compare), exchanges the code, provisions the user, issues the session cookie |
| `POST /auth/logout`  | 302 → provider end-session (or `/`) | 403 `cross_site_request_rejected` (Origin/`Sec-Fetch-Site` mismatch)                 | Clears the session cookie; RP-initiated logout when the provider advertises `end_session_endpoint`         |
| `GET /api/me`        | `{user: {name, email}}`             | 401                                                                                  | Whoami for the header user chip                                                                            |

All data endpoints are **scoped to the session user**: they only see and
mutate their own accounts, imports, transactions, labels and rules.

**CSRF**: every mutating (non-GET) endpoint validates `Origin`/`Sec-Fetch-Site`
against the app origin (lib/auth/guard.ts `assertSameOrigin`) and answers
`403 {"error":"cross_site_request_rejected"}` on mismatch, on top of the
SameSite=Lax session cookie.

## Endpoints

| Method & path                       | Success                                                                       | Errors                                                                                                                                                                                  | Purpose                                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/imports`                 | **202** `{batchId, account: {name, iban}, snapshotDate, snapshotAmountCents}` | 400 (empty/no file, parse failure), 413 (>25 MB), 409 `import_in_progress`                                                                                                              | Upload CSV (`multipart/form-data`, field `file`); preamble-validated, then background import ([ADR-0010](adr/adr-0010-single-flight-import.md))                   |
| `GET /api/imports/[id]`             | `{…batch, labelsTotal, labelsDone, labelsFailed}`                             | 404                                                                                                                                                                                     | Batch status + live counters (polled at 1 Hz by the UI)                                                                                                           |
| `GET /api/imports/history`          | `{batches: [...]}`                                                            | —                                                                                                                                                                                       | Latest 50 batches, newest first                                                                                                                                   |
| `GET /api/transactions`             | `{rows, total, page, pageCount}`                                              | —                                                                                                                                                                                       | Filtered/sorted/paged rows; params: `q, dateFrom, dateTo, type, categoryId (repeated), accountId, labelStatus, status, sort, dir, page, pageSize` (clamped ≤ 100) |
| `POST /api/transactions/[id]/label` | `{id, labelId}`                                                               | 400 `invalid_label`, 404 `not_found` / `label_not_found`, 500 `insert_failed` (inline `labelName` create; color-index collision caught by the unique index; unreachable single-process) | Manual assignment; body `{labelId?}` or `{labelName?}` (creates the category); **learns a rule** when the triple is present                                       |
| `GET /api/analytics`                | `AnalyticsResult`                                                             | —                                                                                                                                                                                       | KPIs/charts for the same filter params ([analytics.md](analytics.md))                                                                                             |
| `GET /api/labels`                   | `{labels: [{id, name, origin, usageCount, color, ruleCount}]}`                | —                                                                                                                                                                                       | Ordered by usage desc, name asc                                                                                                                                   |
| `POST /api/labels`                  | **201** `{id, name}`                                                          | 400 `invalid_name`, 409 `name_conflict`, 500 `insert_failed` (color-index collision caught by the unique index; unreachable single-process)                                             | Create label                                                                                                                                                      |
| `PATCH /api/labels/[id]`            | `{id, name}`                                                                  | 400 / 404 / 409                                                                                                                                                                         | Rename (flips `origin` to `manual`)                                                                                                                               |
| `DELETE /api/labels/[id]`           | `{affected}`                                                                  | 404                                                                                                                                                                                     | **One transaction**: reset carrying transactions to `pending/attempts 0`, re-point completed batches to `labeling`, delete label (rules cascade)                  |
| `GET /api/labels/[id]/rules`        | `{rules: [...]}`                                                              | 400 `invalid_id`, 404 `not_found`                                                                                                                                                       | Learned rules for a label                                                                                                                                         |
| `POST /api/labels/retry`            | **202** `{queued}`                                                            | —                                                                                                                                                                                       | Fire-and-forget reset of attempt-exhausted rows to a fresh budget                                                                                                 |
| `PATCH /api/label-rules/[id]`       | `{rule}`                                                                      | 400 / 404 / 409                                                                                                                                                                         | Edit rule triple (all three fields required, non-empty)                                                                                                           |
| `DELETE /api/label-rules/[id]`      | `{deleted: 1}`                                                                | 404                                                                                                                                                                                     | Delete a learned rule                                                                                                                                             |
| `GET /api/label-rules/[id]/matches` | `{count}`                                                                     | 404                                                                                                                                                                                     | Preview count — same exclusion logic as apply so preview == actual                                                                                                |
| `POST /api/label-rules/[id]/apply`  | `{applied}`                                                                   | 404 (label deleted concurrently)                                                                                                                                                        | Set `categoryId` on matching booked rows, reset to `pending` for LLM confirmation                                                                                 |
| `GET /api/categories`               | `{categories: [{id, name, origin, usageCount, color, count}]}`                | —                                                                                                                                                                                       | With live transaction counts (left join, group by)                                                                                                                |
| `GET /api/accounts`                 | `{accounts}`                                                                  | —                                                                                                                                                                                       | Known accounts                                                                                                                                                    |
| `POST /api/accounts`                | **201** `{account}`                                                           | 400                                                                                                                                                                                     | Manual account entry (`{iban, name}`)                                                                                                                             |
| `DELETE /api/accounts`              | `{deleted}`                                                                   | 400, 404, 409 `account_in_use` (account has transactions/import batches)                                                                                                                | Delete an unused account by `?iban=`; accounts with history are rejected                                                                                          |
| `GET /api/llm/health`               | `{status: "ok" \| "degraded" \| "unreachable"}`                               | —                                                                                                                                                                                       | Proxy to llama-server `/health` (5 s timeout); **always HTTP 200** — dependency status lives in the body                                                          |

## Conventions

- **Dynamic params** are promises and must be awaited:
  ```ts
  export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) { const { id } = await params; … }
  ```
- **409 on conflicts** — unique-constraint violations are caught and mapped
  to `name_conflict` / triple-conflict responses after an advisory
  pre-check (the pre-check gives a friendly message; the catch covers the
  race window).
- **202 for accepted background work** — import upload and label retry
  return 202 immediately; the UI polls status endpoints.
- **No caching** — every handler pins `dynamic = "force-dynamic"`; responses
  are always computed from the current DB state.
- **Status-code-free health** — `/api/llm/health` returning 200 even when
  the LLM is unreachable is deliberate: the Docker healthcheck must reflect
  process liveness, not dependency status ([ADR-0028](adr/adr-0028-shallow-healthcheck.md)).

## Error semantics worth knowing

- `invalid_label` / `invalid_name` (400): names must be 1–64 UTF-8 bytes,
  control-character-free, and survive `sanitizeField()` unchanged
  ([labelling.md](labelling.md)).
- Label/rule mutations validate against the DB **inside the mutation
  transaction** where races matter (e.g. apply re-checks label existence to
  avoid FK failures from a concurrent delete).
