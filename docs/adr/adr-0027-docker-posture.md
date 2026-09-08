# ADR-0027: Docker posture — NAPI prebuilds, standalone output, single write target, non-root

_Status: accepted · Date: 2026-08 (pre-v1.0.0)_

## Context

The image must ship a native addon (better-sqlite3) and a SQLite write
directory, stay small, and start without build tooling.

## Decision

[Dockerfile](../../Dockerfile):

- **Multi-stage** on `node:24-bookworm-slim` (both stages) — glibc is what
  the NAPI prebuild needs; the Node major is ABI-stable across upgrades.
- **Bun copied from the official image** for the build only;
  `bun install --frozen-lockfile --ignore-scripts` skips the implicit
  `node-gyp rebuild` — the prebuilt NAPI binary ships in the tarball, so no
  python/make/g++ toolchain is needed.
- **Next standalone output** with explicit `outputFileTracingIncludes` for
  better-sqlite3 (tracing can't follow `lib/binding.js`'s dynamic require of
  the platform prebuild) — plus a **fail-fast `RUN test -f …prebuilds/linux-x64.node`**
  so a tracing regression fails the image build, not runtime.
- **Single write target**: only `/app/data` is created and chowned; the app
  runs as `USER node`. `next.config.ts` uses `serverExternalPackages` for the
  native addon.
- Image named after the app (`dkb-analytics`), one immutable tag per
  release, no `latest`, amd64, provenance disabled.

## Alternatives considered

- **Alpine base** — musl breaks the glibc prebuild assumption; a from-source
  build needs a full toolchain in the image.
- **Compile better-sqlite3 in the image** — slower builds, larger image, for
  nothing the prebuild doesn't provide.
- **Root user with broad writes** — unnecessary; the db directory is the
  only write surface.

## Consequences

- Positive: small, fast-building, least-privilege image; build fails loudly
  on tracing regressions.
- Negative: the prebuild path is version-coupled (the fail-fast guard and
  Dependabot's docker allow-list keep that honest).
