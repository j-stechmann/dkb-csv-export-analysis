# ADR-0030: Dependabot minor/patch-only with redundant major blocking and CI-gated auto-merge

_Status: accepted · Date: 2026-08 (pre-v1.0.0)_

## Context

Dependencies should stay fresh without flooding a one-person project with
PRs — and majors (Next 16 breaking changes, better-sqlite3 NAPI coupling)
must never slip in unreviewed.

## Decision

[dependabot.yml](../../.github/dependabot.yml): three ecosystems (bun,
docker, github-actions), **minor+patch only** (majors ignored across the
board), daily, limit 5, all targeting `develop`; bun minor/patch updates are
**grouped into one PR**.

[dependabot-auto-merge.yml](../../.github/workflows/dependabot-auto-merge.yml):
runs on every PR but gates to `dependabot[bot]` in this repo; **independently
blocks any `*major*` update type** (defense in depth — even if an ignore
rule ever slips, e.g. docker tag edge cases); waits for CI via `gh pr checks
--watch --fail-fast`; then approves and `gh pr merge --auto --merge` so
GitHub re-evaluates branch protection atomically once the required check
completes.

## Alternatives considered

- **Auto-merge majors too** — unacceptable: Next.js majors have breaking
  changes (documented in `AGENTS.md`); docker majors can break the prebuild
  posture (ADR-0027).
- **Manual updates only** — drifts; the grouped minor PR keeps lockfile
  freshness with one review per day at most.
- **Renovate** — more configuration power than needed for 3 ecosystems.

## Consequences

- Positive: fresh minor/patch deps with ~one PR/day; majors are doubly
  blocked; merges are atomic with protection rules.
- Negative: majors require a manual PR (deliberate friction); the workflow
  must stay in sync with dependabot's config by hand.
