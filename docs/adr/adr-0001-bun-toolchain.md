# ADR-0001: Bun + Next.js 16 + React 19 + strict TypeScript toolchain

_Status: accepted · Date: 2026-08 (initial commits)_

## Context

The project needed a decision on runtime, framework, and language strictness
before any code. Candidates for runtime were Node.js with npm/pnpm and Bun;
for the framework, Next.js versions in common use; TypeScript strictness was
optional.

## Decision

Standardize on **Bun** (pinned via `.bun-version`, used for install, scripts,
tests, and CI), **Next.js 16 + React 19**, and **TypeScript in `strict` mode
from day one**.

## Alternatives considered

- **Node.js + npm/pnpm** — more familiar, slower installs, one more toolchain
  file; nothing in this codebase needs Node-specific tooling beyond
  better-sqlite3 (which Bun supports).
- **Older Next.js LTS-style version** — fewer surprises but no benefit; the
  app is a greenfield local tool.
- **Non-strict TS** — defers type errors to runtime; worthless for a
  correctness-focused app.

## Consequences

- Positive: single toolchain file (`.bun-version`) pins dev/CI/Docker;
  fastest installs; strict types catch money/DB mistakes at compile time.
- Negative: this Next.js version has breaking changes vs. common knowledge —
  `AGENTS.md` warns every agent to read the vendored docs in
  `node_modules/next/dist/docs/` before writing code.
- Neutral: `bun.lock` is the single source of dependency truth; Dependabot
  uses the dedicated `bun` ecosystem.
