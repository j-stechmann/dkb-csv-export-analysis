# ADR-0023: Client components everywhere; React Query as the data layer

_Status: accepted · Date: 2026-08 (initial commits)_

## Context

The UI is three live dashboards (filters, polling, optimistic toasts) over a
REST API. Options ranged from server components with server actions to a
full SPA.

## Decision

**Every page is a client component**; `app/layout.tsx` is the only Server
Component (static shell with client islands: nav, health badge, theme
toggle). **React Query 5** is the sole data layer: `staleTime: 5_000`,
`refetchOnWindowFocus: false`, filter state serialized into query keys,
conditional polling (1 s active batch, 5 s history, 30 s LLM health), and
explicit invalidation fan-outs after mutations (see
[frontend.md](../frontend.md)). No server actions, no server-side data
fetching, no Suspense streaming; loading/error states are React Query
`isLoading`/`isError` with skeletons and an `ErrorState` banner.

## Alternatives considered

- **Server Components + server actions** — nice for content sites; wrong
  fit for a dashboard where nearly everything is interactive state.
- **Plain fetch + useState** — re-implements caching, polling, and
  invalidation badly.
- **tRPC/Zod query contracts** — the API is hand-rolled and small
  ([ADR-0025](adr-0025-manual-api-validation.md)); a contract layer would
  outsize its benefit.

## Consequences

- Positive: simple mental model (one rendering mode), cache behavior is
  explicit and testable, polling is trivially conditional.
- Negative: no SSR benefits (irrelevant for a local tool); the client bundle
  carries everything — acceptable at this size.
