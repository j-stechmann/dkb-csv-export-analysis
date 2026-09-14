# ADR-0031: No-auth, local-first privacy posture

_Status: accepted · Date: 2026-08 (initial commits), restated v1.8.0_

## Context

The app processes sensitive bank data (IBANs, counterparty names, full
transaction history). It runs locally for a single user — but "local tool"
and "handles bank data" pull the security design in different directions.

## Decision

**No authentication, no sessions, no middleware.** The threat model is a
single user's machine, not a shared deployment; simplicity is a feature.
Privacy is protected by **data locality instead of access control**:

- All bank data stays on the machine: SQLite in `data/` (gitignored),
  models in `models/`, `.llm-model`, `Makefile.local`, `.env*` — all
  gitignored and dockerignored; bank data never leaves the machine.
- The **only network egress** is the one-time model download from Hugging
  Face and LLM calls to llama-server, which binds `127.0.0.1` in local dev.
- The Docker image runs as `USER node` with a single chowned write target
  ([ADR-0027](adr-0027-docker-posture.md)); the healthcheck never leaks
  dependency state in status codes ([ADR-0028](adr-0028-shallow-healthcheck.md)).

**The app must not be exposed to untrusted networks** — this posture is
documented in the root README and [operations.md](../operations.md).

## Alternatives considered

- **Add auth (even basic)** — meaningful only with multi-user or network
  exposure, which the product explicitly does not target; auth would add
  secret management to a zero-secret app.
- **Cloud-sync the database** — the antithesis of the privacy stance; the
  only egress decisions (model download, LLM calls) are user-initiated and
  inspectable.

## Consequences

- Positive: zero-config startup; no secrets to leak; a small audit surface
  (two egress paths).
- Negative: the posture fails _silently_ if someone reverse-proxies the app
  to the internet — hence the explicit warning in the docs; no defense
  against local malware (out of scope for the threat model).
