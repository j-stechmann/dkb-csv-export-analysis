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

## Docker

Images are built and pushed to GHCR by the release workflow
(`.github/workflows/release.yml`) after QA passes — one tag per release:

```
ghcr.io/j-stechmann/dkb-analytics:<release-tag>   e.g. ghcr.io/j-stechmann/dkb-analytics:v0.0.1
```

All configuration is read from the environment at runtime, so no rebuild is
needed to point the app at your labeller or database. Use a named volume for
the database directory (bind mounts don't pick up the image's directory
ownership and will hit permission errors unless host uid matches):

```yaml
services:
  app:
    image: ghcr.io/j-stechmann/dkb-analytics:v0.0.1
    ports:
      - "3000:3000"
    environment:
      DATABASE_PATH: /app/data/dkb.db
      LABELLER_BASE_URL: http://labeller:8080 # labeller service on the compose network
      # LABELLER_LANGUAGE: de                 # optional, defaults in lib/config.ts
      # LABELLER_BATCH_SIZE: "100"
      # LABELLER_MAX_RETRIES: "3"
    volumes:
      - dkb-data:/app/data # required: SQLite db + WAL are written at runtime

volumes:
  dkb-data:
```

The database schema is created automatically on first boot. To run the
labeller alongside the app, add it as another service and set
`LABELLER_BASE_URL` to its service name.

## Correctness

All amounts are stored as integer cents and verified by a test suite that
includes property-based round-trips (20k random amounts), a synthetic
24-month fixture with a hand-computed KPI manifest asserted **to the cent**
through the real HTTP API, and dedupe/labeller edge cases:

```bash
bunx vitest run
```