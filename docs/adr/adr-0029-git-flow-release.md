# ADR-0029: Git-flow with GitHub Release as the publish trigger and immutable exact tags

_Status: accepted · Date: 2026-09 (v1.8.0+, PR #22)_

## Context

Releases were ad-hoc tags; the project needed a predictable flow with a
required quality gate and reproducible artifacts.

## Decision

**Git-flow** ([CONTRIBUTING.md](../../CONTRIBUTING.md)): all development on
`develop`, `master` holds released code, work branches `feat/* fix/* chore/*
refactor/*`, `release/*` for stabilization + version bump, `hotfix/*` from
`master` with mandatory back-merge. Conventional Commits. Branch protection
requires the `ci` check, up to date with head, **enforced for admins**.

**The GitHub Release (not the git tag) is the publish trigger**:
`release.yml` runs on `release: published`, re-runs the full CI as a
reusable `quality-assurance` job (`workflow_call`), then pushes
`ghcr.io/j-stechmann/geldlage:<tag>` — **one immutable tag, no
`latest`**, image named after the app rather than the repo, amd64,
provenance disabled.

## Alternatives considered

- **Trunk-based with merge queues** — simpler, but the develop integration
  branch gives a stable base for Dependabot and release stabilization.
- **Tag-push triggers the image build** — tags can be moved/deleted; the
  GitHub Release object is the deliberate, reviewable act of publishing.
- **Floating `latest` tag** — non-reproducible deployments; exact tags only.

## Consequences

- Positive: releases can never skip QA (workflow composition); artifacts are
  immutable and auditable; admins obey the same rules.
- Negative: two long-lived branches to keep in sync (hotfix back-merges are
  mandatory); slightly heavier release ritual (~2 days per release in
  practice).
