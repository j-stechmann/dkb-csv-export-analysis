# Operations

_Last reviewed against v1.9.0._

Running, configuring, and shipping the app. Setup basics live in the root
[README](../README.md); this guide covers what is behind the commands and
the operational decisions ([ADR-0012](adr/adr-0012-local-llama-server.md),
[ADR-0027](adr/adr-0027-docker-posture.md),
[ADR-0028](adr/adr-0028-shallow-healthcheck.md)).

## The Makefile

Developer entry points ([Makefile](../Makefile)); machine-specific overrides
belong in gitignored `Makefile.local` (included via `-include`), e.g. to opt
into Ollama's GPU-capable llama-server binary:

| Target                                     | What it does                                                                                                                                                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make dev`                                 | Health-checks `:8080`, starts llama-server if needed, installs deps, runs `bun dev` in the foreground; a bash trap stops llama-server on Ctrl-C **only if this invocation started it** (tracked via `/tmp/llama-server.managed`) |
| `make app`                                 | Dev app only (llama-server must already run)                                                                                                                                                                                     |
| `make model`                               | Downloads the pinned GGUF from Hugging Face: resumable (`curl -L -C -`), sanity-gated (≥ 1 GB + `GGUF` magic bytes), records the absolute path in `.llm-model`; accepts `MODEL=/path` or `HF_TOKEN` for gated repos              |
| `make llm`                                 | Starts llama-server in the background: GPU auto-detection via `--list-devices` (CUDA/Vulkan/ROCm/SYCL → `-ngl auto --fit on`, else `-ngl 0` with a loud CPU warning), pid + log in `/tmp`                                        |
| `make llm-wait`                            | Polls `/health` up to 120 × 2 s; detects a dead PID and dumps log tail                                                                                                                                                           |
| `make stop`                                | **Pidfile-targeted `kill -9` only** — never touches llama-server processes this project didn't start                                                                                                                             |
| `make llm-status`                          | Health + `nvidia-smi` GPU usage                                                                                                                                                                                                  |
| `make check`                               | `typecheck` + `lint` + `format:check` (the CI trio)                                                                                                                                                                              |
| `make test` / `build` / `start` / `format` | Vitest / Next build / Next start / Prettier                                                                                                                                                                                      |

Key llama-server flags and why:

- `-c $(LLM_CTX)` — context window (default 8192); must match the app's
  `LLM_CTX` env (the client-side budget guard reads the same variable).
- `--reasoning off` — **mandatory for thinking models**; otherwise the token
  budget is burned before any label is produced.
- `-fa on -ctk q8_0 -ctv q8_0` — flash attention with quantized KV cache;
  `-np 1` — single parallel slot (the app sends one batch at a time).
- `--no-webui` — API only.

The model is **pinned**: one exact GGUF file (`ggml-org/Qwen3.8-27B-GGUF`,
`Qwen3.8-27B-Q4_K_M.gguf`, ~19 GB) at a pinned Hugging Face revision. No
Ollama is involved anywhere — the app only requires an OpenAI-compatible
endpoint. Recipes use bash (`SHELL := /bin/bash`, `-o pipefail`); the
interactive download offer fails fast when stdin is not a TTY (CI/pipes).

## Configuration

All configuration is environment-based, read once via zod-validated
`getConfig()` ([lib/config.ts](../lib/config.ts)):

| Variable                | Default                 | Purpose                                                |
| ----------------------- | ----------------------- | ------------------------------------------------------ |
| `DATABASE_PATH`         | `./data/dkb.db`         | SQLite file (WAL sidecars alongside)                   |
| `LLM_BASE_URL`          | `http://127.0.0.1:8080` | llama-server base URL                                  |
| `LLM_LANGUAGE`          | `de`                    | ISO 639-1 label language                               |
| `LLM_BATCH_SIZE`        | `20` (1–100)            | items per LLM request; > ~40 risks exceeding `LLM_CTX` |
| `LLM_MAX_RETRIES`       | `2`                     | transient-failure retries (timeouts never retry)       |
| `LLM_TIMEOUT_MS`        | `300000`                | per-request timeout                                    |
| `LLM_CTX`               | `8192`                  | must match the server's `-c` flag (budget guard)       |
| `LLM_MAX_ATTEMPTS`      | `5`                     | per-transaction labeling attempt cap                   |
| `LLM_MAX_LABELS_PROMPT` | `200` (0 disables)      | existing labels injected into prompts                  |

See the root README for the full Docker Compose example (app + llama-server
on one network, named volume for `/app/data`).

## Docker image

The release workflow builds and pushes `ghcr.io/j-stechmann/dkb-analytics:<release-tag>`
— one immutable tag per release, no `latest`, amd64
([ADR-0029](adr/adr-0029-git-flow-release.md)). Image anatomy
([Dockerfile](../Dockerfile)):

- **Multi-stage**, `node:24-bookworm-slim` in both stages (glibc is what
  better-sqlite3's NAPI prebuild needs; Node major is ABI-stable). Bun is
  copied in from the official image for the build only.
- `bun install --frozen-lockfile --ignore-scripts` — skips the implicit
  `node-gyp rebuild`; the prebuilt NAPI binary ships in the tarball, so no
  python/make/g++ toolchain is needed.
- **Fail-fast guard**: `RUN test -f .next/standalone/.../prebuilds/linux-x64.node`
  — a silent tracing regression fails the image build, not runtime.
- **Single write target**: only `/app/data` is created and chowned; the app
  runs as `USER node` (least privilege; the SQLite db + WAL are the only
  runtime writes).
- **Shallow healthcheck**: probes `/api/llm/health` — which always returns
  200 — so an external llama-server outage or a bad `DATABASE_PATH` never
  marks the container unhealthy ([ADR-0028](adr/adr-0028-shallow-healthcheck.md));
  schema setup in instrumentation logs failures instead of crashing startup.

## CI / release engineering

| Workflow                    | Trigger                                              | Does                                                                                                                             |
| --------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                    | every push, `workflow_dispatch`, **`workflow_call`** | lint → format check → typecheck → test → build (the reusable quality gate)                                                       |
| `release.yml`               | GitHub Release published                             | runs `ci.yml` as the `quality-assurance` job, then buildx → GHCR push with the exact release tag                                 |
| `dependabot-auto-merge.yml` | Dependabot PRs                                       | waits for CI (`gh pr checks --watch`), approves, `gh pr merge --auto`; **independently blocks major updates** (defense in depth) |
| `dependabot.yml`            | daily                                                | bun/docker/github-actions ecosystems, minor+patch only, grouped bun PRs, all targeting `develop`                                 |

Process rules (git-flow, Conventional Commits, release/hotfix flows) live in
[CONTRIBUTING.md](../CONTRIBUTING.md); decision rationale in
[ADR-0029](adr/adr-0029-git-flow-release.md) and
[ADR-0030](adr/adr-0030-dependabot-policy.md).

## Security & privacy posture

This is a **local-first, no-auth** app that deliberately handles sensitive
bank data simply ([ADR-0031](adr/adr-0031-no-auth-local-first-privacy.md)):

- No authentication, no sessions, no middleware — the threat model is a
  single user's machine, not a shared deployment. Do not expose it to untrusted
  networks.
- All bank data stays local: SQLite in `data/` (gitignored), model in
  `models/` (gitignored), no telemetry. The **only network egress** is the
  model download from Hugging Face (`make model`) and the LLM calls to
  llama-server, which is bound to `127.0.0.1` in local dev.
- `.gitignore` and `.dockerignore` exclude `data/`, `*.db*`, `.env*`,
  `models/`, `.llm-model`, `Makefile.local` — bank data and machine state
  never leave the machine.
- In Docker, llama-server must reach the app's compose network (the README
  example binds `0.0.0.0` _inside_ the compose network only); restrict port
  publishing if you adapt it.

## Backup / restore

Everything stateful is one directory: the SQLite database (WAL mode). Stop
the app (or checkpoint), then copy `data/` (all three files: `dkb.db`,
`dkb.db-shm`, `dkb.db-wal`) or the named Docker volume. Restoring is copying
them back — the schema is auto-created/migrated on next boot.

## Troubleshooting

| Symptom                                           | Likely cause / fix                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Warning about prompt+completion exceeding context | `LLM_BATCH_SIZE` too high for `LLM_CTX` — lower the batch or raise `LLM_CTX` **on both sides** (server flag + app env) |
| Labels stay "wird kategorisiert" forever          | llama-server down or unhealthy — check the header badge / `make llm-status`; the health gate is pausing the worker     |
| Rows "ohne Kategorie"                             | Attempts exhausted — use the retry button (fresh budget); no fallback labels are ever invented                         |
| Batches `failed` after a crash                    | Startup recovery marked interrupted batches failed; re-import the CSV (dedupe makes this safe)                         |
| CPU-only warning from `make llm`                  | GPU build not detected; install CUDA/Vulkan llama.cpp packages or use `Makefile.local` with Ollama's binary            |
