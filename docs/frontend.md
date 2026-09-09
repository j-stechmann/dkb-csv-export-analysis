# Frontend

_Last reviewed against v1.8.0._

Every page is a **client component**: the entire UI is a live dashboard
driven by filters, polling, and toasts, with no server-rendered data
([ADR-0023](adr/adr-0023-client-components-react-query.md)). The only Server
Component is `app/layout.tsx` (static shell hosting client islands: nav,
LLM health badge, theme toggle). This Next.js version has breaking changes
vs. common knowledge — the vendored docs under
`node_modules/next/dist/docs/` are the authoritative reference (see
`AGENTS.md`).

## Stack

| Piece      | Choice                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Framework  | Next.js 16.3.3, React 19 ([ADR-0001](adr/adr-0001-bun-toolchain.md))                                                           |
| Styling    | Tailwind v4 (CSS-first, no config file), oklch palette, `font-serif` body                                                      |
| Components | shadcn/ui "base-nova" style on **`@base-ui/react`** — not Radix ([ADR-0024](adr/adr-0024-ui-stack-tailwind-shadcn-base-ui.md)) |
| Data       | React Query 5 ([ADR-0023](adr/adr-0023-client-components-react-query.md))                                                      |
| Charts     | Recharts 3 in shadcn `ChartContainer`, custom zoom hook                                                                        |
| Toasts     | sonner, one toast per HTTP outcome, German copy                                                                                |
| Icons      | lucide-react                                                                                                                   |
| Theming    | next-themes (class attribute, system default)                                                                                  |

Provider nesting (`components/providers.tsx`): ThemeProvider →
QueryClientProvider → TooltipProvider → ActiveImportProvider →
DragDropProvider → children + ImportProgressPill + Toaster.

## React Query conventions

Global defaults: `staleTime: 5_000`, `refetchOnWindowFocus: false` —
deliberately conservative; only three things poll:

| Query key                            | Fetches               | Polling                                                  |
| ------------------------------------ | --------------------- | -------------------------------------------------------- |
| `["analytics", params]`              | `/api/analytics?…`    | — (invalidation-driven)                                  |
| `["transactions", params]`           | `/api/transactions?…` | —                                                        |
| `["labels"]`, `["categories"]`       | label/category lists  | —                                                        |
| `["label-rules", labelId]`           | rules per label       | —                                                        |
| `["label-rules", ruleId, "matches"]` | rule match preview    | live: refetched by invalidation while the dialog is open |
| `["imports"]`                        | import history        | 5 s                                                      |
| `["import", batchId]`                | active batch status   | **1 s, only while non-terminal**                         |
| `["llm-health"]`                     | LLM reachability      | 30 s                                                     |

- **Two-phase keys**: filter/page/sort state serializes into the key
  (`["transactions", params.toString()]`), so every combination gets its own
  cache entry and back/forward between filter states hits cache.
- **`placeholderData: prev => prev`** on table and analytics queries keeps
  content visible (dimmed) during refetches instead of flickering to
  skeletons.
- **Invalidation fan-out**: the labels page has a shared `invalidateAll()`
  hitting `labels`, `label-rules`, `transactions`, `analytics`, `categories`
  after any label/rule mutation; import completion invalidates
  `analytics`/`transactions`/`categories`/`labels`; retry invalidates
  `imports`/`import`/`transactions`/`analytics`/`categories`. Mutations are
  plain `fetch` calls in event handlers (no `useMutation`), each branch with
  its own toast.
- **Value-based filter reset**: the table resets `page` to 1 when filters
  change without an effect — `filterKey` (memoized `filtersToParams
(filters).toString()`) is compared against `lastFilterKey` state during
  render, and a difference triggers `setPage(1)`. Page changes alone don't
  re-fire it.

## Pages

### `/` — Dashboard

FilterBar (debounced text, date range, type, single category) → KPI row →
four charts → transactions table. The table is **hand-rolled on shadcn
`Table` primitives** with server-side everything: pagination (fixed 25
rows), sorting (booking date, amount, payee), and filtering all happen in
SQL; the client only serializes state into the query string
([ADR-0026](adr/adr-0026-server-side-table.md)). Category cells are badges
colored by the golden-ratio oklch palette; pending rows show a dashed "wird
kategorisiert" badge, failed/unlabeled rows "ohne Kategorie".

**Label assignment** (`AssignLabelDialog`): clicking a category cell opens a
searchable label list — single click selects, **double-click assigns
instantly**; a "…neu erstellen und zuweisen" action POSTs `{labelName}` (the
server creates the category and learns the rule in the same request).

### `/imports`

Dropzone (file picker + per-page drop), the active import card (stage,
two progress bars: rows `(imported+duplicate+updated)/total` and labels
`(done+failed)/total`), and history with a retry-labeling button for
exhausted rows.

**Drag-and-drop** works globally: `components/drag-drop-provider.tsx` listens
on window-level `dragenter/dragover/dragleave/drop` with a drag counter (to
survive child enter/leave noise) and shows a full-screen "CSV hier ablegen"
overlay; drops validate the `.csv` extension and POST the file as
`FormData`, then the shared `ActiveImportProvider` polls the new batch at
1 Hz until `completed`/`failed` and fires the invalidation fan-out + toast.

### `/labels`

Label CRUD (create form, rename dialog — which flips `origin` to `manual` —
and a delete dialog that spells out the consequences: transactions lose their
category and get re-labeled by the LLM, learned rules are removed). Each
label lists its learned rules with edit/delete plus the **apply dialog**,
whose match count is the live `["label-rules", ruleId, "matches"]` query so
the preview tracks concurrent changes while open. Rule dialogs are derived
from the live rules list (`rules.find(...)`), so a concurrently deleted rule
auto-closes its dialog instead of operating on stale state. Rules are only
created implicitly — by assigning labels in the transactions table.

## Import lifecycle components

| Component                               | Role                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `components/drag-drop-provider.tsx`     | window-level drop overlay + upload                                                 |
| `components/active-import-provider.tsx` | tracks the newest batch, 1 s polling while non-terminal, completion fan-out        |
| `components/import-progress-pill.tsx`   | fixed bottom-center pill with stage + two progress bars, dismissible when terminal |
| `components/labeller-health-badge.tsx`  | header badge polling `/api/llm/health` every 30 s                                  |

## Chart zoom

[hooks/use-chart-zoom.ts](../hooks/use-chart-zoom.ts) implements
pinch/wheel zoom + drag pan on the time-series charts: a non-passive wheel
listener (so `preventDefault` works), anchor-based scaling around the cursor,
drag-to-pan with bounds clamping, and a `resetKey` so a dataset/filter change
resets the window.

## Category colors

Every label gets a **permanent, unique** display color, stored in
`categories.color` (unique index; NULL only as legacy fallback). Colors are
allocated at creation inside the insert transaction
([lib/category-colors.ts](../lib/category-colors.ts)
`pickCategoryColor`): the first unused entry of the curated 12-color oklch
palette, then procedurally generated colors (golden-ratio hue walk, never
gray, picking the candidate farthest from all used colors). Existing DBs are
backfilled deterministically in `id ASC` order on startup. `null`
(unlabeled) is gray. The badge mixes the color via a CSS custom property +
`color-mix()` (`@utility category-badge` in `app/globals.css`). Rendering
falls back to a golden-ratio hash (`getCategoryColor`) only for legacy NULL
rows.

## Language

The UI is German-only (matching the DKB domain vocabulary — see the
[glossary](README.md#glossary)), while the **LLM label language** is
configurable via `LLM_LANGUAGE` (ISO 639-1, default `de`). No i18n framework
is used; strings are inline.
