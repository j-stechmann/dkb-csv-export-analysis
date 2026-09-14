# ADR-0024: Tailwind v4 + shadcn "base-nova" on @base-ui/react

_Status: accepted · Date: 2026-08 (initial commits)_

## Context

The UI needs accessible primitives (dialogs, selects, tooltips) and a
consistent styling system without design work.

## Decision

- **Tailwind v4** in CSS-first mode (`@import "tailwindcss"`, no
  `tailwind.config.*`), oklch color variables, `@custom-variant dark`,
  `@utility category-badge` with `color-mix()`.
- **shadcn/ui with the "base-nova" style, built on `@base-ui/react` — not
  Radix** (`components.json`); components live in `components/ui/*`, icons
  from lucide-react, toasts from sonner, theming via next-themes.
- Category colors are a 12-color oklch palette selected by a golden-ratio
  hash on category id (`(id · 0.618033988749895) % 1`) — stable per label
  without a stored mapping, adjacent ids far apart; `null` → gray.

## Alternatives considered

- **Radix-based shadcn (classic)** — more ecosystem history; base-nova's
  Base UI primitives ship with the current shadcn generator and match React 19.
- **Component library (MUI, Mantine)** — heavier, generic look, more runtime.
- **Tailwind v3 with config file** — the v4 CSS-first setup removes a config
  surface.

## Consequences

- Positive: small, themable, accessible; colors are deterministic and
  dependency-free; no config file drift.
- Negative: Base UI is less battle-tested than Radix; several generated
  primitives (`sidebar`, `sheet`, `dropdown-menu`, …) are unused dead weight
  in `components/ui/`.
