# DKB Analytics

Next.js app for analyzing DKB banking CSV exports: import via drag-and-drop,
automatic categorization through a local labeller service, and analytics
(balance, monthly cash flow, savings rate, top categories) that always
reflect the filtered query results.

## Setup

```bash
bun install
bun run build && bun run start   # or: bun run dev
```

Environment (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_PATH` | `./data/dkb.db` | SQLite database file |
| `LABELLER_BASE_URL` | `http://127.0.0.1:8080` | transaction-labeller service |
| `LABELLER_LANGUAGE` | `de` | ISO 639-1 label language |
| `LABELLER_BATCH_SIZE` | `100` | max items per labeller request |
| `LABELLER_MAX_RETRIES` | `3` | retries when labeller is down |

Imports: drag any DKB CSV export onto the window. Processing runs in the
background; progress is shown in the floating pill and on the Imports page.
Re-importing the same or overlapping exports deduplicates automatically —
transactions are never deleted.

## Correctness

All amounts are stored as integer cents and verified by a test suite that
includes property-based round-trips (20k random amounts), a synthetic
24-month fixture with a hand-computed KPI manifest asserted **to the cent**
through the real HTTP API, and dedupe/labeller edge cases:

```bash
bunx vitest run
```