# DKB Analytics — developer entry points
#
# Quick start:
#   make dev     # llama-server + Next.js app together (offers model download
#                # on first run; Ctrl-C stops llama-server too)
#   make stop    # stop llama-server (the app runs in the foreground)
#
# Machine-specific overrides (binary paths, env) belong in Makefile.local
# (gitignored, included below).

# ── LLM configuration ────────────────────────────────────────────────────────
# The pinned model: one exact file from Hugging Face, resolved at a pinned
# revision. `make model` downloads it into $(MODEL_DIR) and records the path
# in $(MODEL_FILE). No Ollama involved anywhere.
# Alternative quant, e.g. unsloth's slightly smaller imatrix build:
#   make model MODEL_HF_REPO=unsloth/Qwen3.8-27B-GGUF MODEL_HF_FILE=Qwen3.8-27B-UD-Q4_K_M.gguf MODEL_HF_REVISION=
#   (MODEL_HF_REVISION= pins nothing / tracks the repo default branch)
MODEL_HF_REPO     ?= ggml-org/Qwen3.8-27B-GGUF
MODEL_HF_FILE     ?= Qwen3.8-27B-Q4_K_M.gguf
MODEL_HF_REVISION ?= 0669b98607d47046c7c2b3f801011d54a08cfccf
MODEL_DIR         ?= models
MODEL_SIZE        ?= 18973870432
MODEL_FILE        ?= .llm-model
LLM_HOST          ?= 127.0.0.1
LLM_PORT          ?= 8080
LLM_CTX           ?= 8192

# an empty MODEL_HF_REVISION means "track the repo default branch"
MODEL_REV = $(if $(MODEL_HF_REVISION),$(MODEL_HF_REVISION),main)
MODEL_URL = https://huggingface.co/$(MODEL_HF_REPO)/resolve/$(MODEL_REV)/$(MODEL_HF_FILE)
MODEL_PATH = $(MODEL_DIR)/$(MODEL_HF_FILE)

# Local overrides (LLAMA_SERVER, LLAMA_ENV, MODEL_FILE, …)
-include Makefile.local

# llama-server binary: LLAMA_SERVER (env/Makefile.local) wins, else PATH.
# GPU support is auto-detected at launch via --list-devices: a CUDA/Vulkan/
# ROCm-capable build runs with GPU offload, a CPU-only build runs on CPU
# with a warning (never through Ollama). To opt into Ollama's vendored
# GPU-capable llama-server explicitly, create Makefile.local with:
#   LLAMA_SERVER = /usr/lib/ollama/llama-server
#   LLAMA_ENV = GGML_BACKEND_PATH=/usr/lib/ollama/cuda_v13/libggml-cuda.so \
#               LD_LIBRARY_PATH=/usr/lib/ollama/cuda_v13
LLAMA_SERVER ?= $(shell command -v llama-server 2>/dev/null)

# recipes use bash-only syntax (arrays, ${auth[@]}) — don't rely on /bin/sh
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

.PHONY: help dev app model llm stop llm-status test check format build start

help:
	@echo "DKB Analytics — make targets:"
	@echo "  make dev        llama-server + dev app together (offers model download; Ctrl-C stops both)"
	@echo "  make app        dev app only (llama-server must already run)"
	@echo "  make model      download the pinned model ($(MODEL_HF_FILE), ~$$(($(MODEL_SIZE) / 1000000000)) GB) — run once"
	@echo "  make llm        start llama-server in the background (log: /tmp/llama-server.log)"
	@echo "  make stop       stop llama-server"
	@echo "  make llm-status health + GPU usage check"
	@echo "  make test       run the vitest suite"
	@echo "  make check      typecheck + lint + prettier"
	@echo "  make format     prettier write"
	@echo "  make build      production build"
	@echo "  make start      run the production build"
	@echo ""
	@echo "Model source: $(MODEL_URL)"
	@echo "Model file:   $(MODEL_PATH)"
	@echo "Server binary: $(LLAMA_SERVER)"
	@echo "Custom model: make llm MODEL=/path/to/model.gguf"

# ── combined / app ───────────────────────────────────────────────────────────
# dev = llama-server (if not already running) + foreground app. When this
# command started llama-server itself, Ctrl-C stops it again; a pre-existing
# server is left alone.
dev:
	@if ! curl -s -m 2 http://$(LLM_HOST):$(LLM_PORT)/health >/dev/null 2>&1; then \
		$(MAKE) --no-print-directory llm; \
		touch /tmp/llama-server.managed; \
	else \
		echo "llama-server already running on :$(LLM_PORT) (left running after exit)"; \
	fi; \
	trap 'if [ -f /tmp/llama-server.managed ]; then rm -f /tmp/llama-server.managed; $(MAKE) --no-print-directory stop; fi' EXIT INT TERM; \
	if [ ! -d node_modules ]; then echo "installing dependencies…"; bun install; fi; \
	bun dev

app:
	@if [ ! -d node_modules ]; then echo "installing dependencies…"; bun install; fi; \
	bun dev

# ── model management ────────────────────────────────────────────────────────
# Interactive offer used by `dev` and `llm`: when no model is configured,
# ask whether to run the (large) download now. Non-tty (CI/pipes) → fail
# fast with instructions instead.
define model_offer
	if [ ! -t 0 ]; then \
		echo "No model configured."; \
		echo "Run:  make model   (downloads $(MODEL_HF_REPO)/$(MODEL_HF_FILE), ~$$(($(MODEL_SIZE) / 1000000000)) GB)"; \
		echo "or:   make llm MODEL=/path/to/model.gguf"; \
		exit 1; \
	fi; \
	printf "No model configured (%s, ~%s GB).\n" "$(MODEL_PATH)" "$$(($(MODEL_SIZE) / 1000000000))"; \
	printf "Download now from Hugging Face (%s)? [y/N] " "$(MODEL_HF_REPO)"; \
	read -r answer; \
	case "$$answer" in \
		y|Y|yes|Yes|YES) $(MAKE) --no-print-directory model || exit 1; ;; \
		*) \
			echo "Aborted. Download later with:"; \
			echo "  make model"; \
			echo "or point at an existing GGUF:"; \
			echo "  make llm MODEL=/path/to/model.gguf"; \
			exit 1; ;; \
	esac
endef

# ── llama-server ────────────────────────────────────────────────────────────
llm:
	@if [ -n "$(MODEL)" ]; then model="$(MODEL)"; \
	elif [ -f "$(MODEL_FILE)" ] && [ -f "$$(cat $(MODEL_FILE) 2>/dev/null)" ]; then model=$$(cat $(MODEL_FILE)); \
	else model=""; fi; \
	if [ -z "$$model" ] || [ ! -f "$$model" ]; then \
		$(model_offer); \
	fi; \
	if [ -z "$(LLAMA_SERVER)" ]; then \
		echo "llama-server not found on PATH."; \
		echo "Install llama.cpp (CUDA build for GPU) or set LLAMA_SERVER=/path/to/llama-server"; \
		exit 1; \
	fi; \
	if curl -s -m 2 http://$(LLM_HOST):$(LLM_PORT)/health >/dev/null 2>&1; then \
		echo "llama-server already running on :$(LLM_PORT)"; \
		exit 0; \
	fi; \
	if $(LLAMA_ENV) $(LLAMA_SERVER) --list-devices 2>/dev/null | grep -qE "CUDA0|Vulkan0|ROCm|SYCL0"; then \
		gpu_args="-ngl auto --fit on"; \
		echo "GPU detected — starting with GPU offload"; \
	else \
		gpu_args="-ngl 0"; \
		echo "WARNING: no GPU support in $(LLAMA_SERVER) — running CPU-only (slow)."; \
		if [ -x /usr/lib/ollama/llama-server ] && [ -f /usr/lib/ollama/cuda_v13/libggml-cuda.so ]; then \
			echo "hint: a GPU-capable llama-server exists (shipped by Ollama). To opt in explicitly, create Makefile.local:"; \
			echo "  LLAMA_SERVER = /usr/lib/ollama/llama-server"; \
			echo "  LLAMA_ENV = GGML_BACKEND_PATH=/usr/lib/ollama/cuda_v13/libggml-cuda.so LD_LIBRARY_PATH=/usr/lib/ollama/cuda_v13"; \
		fi; \
	fi; \
	echo "Starting llama-server ($$model) on :$(LLM_PORT)…"; \
	$(LLAMA_ENV) nohup $(LLAMA_SERVER) -m "$$model" -c $(LLM_CTX) -np 1 -fa on -ctk q8_0 -ctv q8_0 $$gpu_args --reasoning off --host $(LLM_HOST) --port $(LLM_PORT) --no-webui > /tmp/llama-server.log 2>&1 & \
	pid=$$!; \
	echo "pid $$pid — log: /tmp/llama-server.log"; \
	echo $$pid > /tmp/llama-server.pid; \
	$(MAKE) --no-print-directory llm-wait

# Download the pinned model from Hugging Face (resumable; no Ollama).
model:
	@if [ -n "$(MODEL)" ]; then \
		if [ ! -f "$(MODEL)" ]; then echo "MODEL=$(MODEL): file not found"; exit 1; fi; \
		readlink -f "$(MODEL)" > $(MODEL_FILE); \
		echo "Model set: $$(cat $(MODEL_FILE))"; \
		exit 0; \
	fi; \
	if [ -f "$(MODEL_FILE)" ] && [ -f "$$(cat $(MODEL_FILE))" ]; then \
		echo "Model already configured: $$(cat $(MODEL_FILE))"; \
		exit 0; \
	fi; \
	mkdir -p $(MODEL_DIR); \
	url="$(MODEL_URL)"; \
	if [ -n "$${HF_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $$HF_TOKEN"); \
	else auth=(); fi; \
	echo "Downloading $(MODEL_HF_REPO)/$(MODEL_HF_FILE) (~$$(($(MODEL_SIZE) / 1000000000)) GB)…"; \
	echo "  $$url"; \
	curl -L -C - --fail --progress-bar "$${auth[@]}" -o "$(MODEL_PATH).part" "$$url" || { \
		echo "download failed (resumable — re-run 'make model' to continue)"; exit 1; }; \
	if [ "$$(stat -c %s "$(MODEL_PATH).part")" -lt 1000000000 ]; then \
		echo "downloaded file suspiciously small — aborting"; exit 1; \
	fi; \
	if [ "$$(head -c 4 "$(MODEL_PATH).part")" != "GGUF" ]; then \
		echo "downloaded file is not a GGUF — aborting"; exit 1; \
	fi; \
	mv "$(MODEL_PATH).part" "$(MODEL_PATH)"; \
	readlink -f "$(MODEL_PATH)" > $(MODEL_FILE); \
	echo "Model ready: $$(cat $(MODEL_FILE)) (recorded in $(MODEL_FILE))"

llm-wait:
	@echo -n "waiting for llama-server"; \
	for i in $$(seq 1 120); do \
		if curl -s -m 2 http://$(LLM_HOST):$(LLM_PORT)/health 2>/dev/null | grep -q ok; then \
			echo " ready"; exit 0; \
		fi; \
		pid=$$(cat /tmp/llama-server.pid 2>/dev/null || echo ""); \
		if [ -n "$$pid" ] && [ $$i -gt 3 ] && ! kill -0 $$pid 2>/dev/null; then \
			echo; echo "llama-server failed to start — last log lines:"; \
			tail -5 /tmp/llama-server.log | strings; exit 1; \
		fi; \
		printf "."; sleep 2; \
	done; \
	echo; echo "timeout waiting for llama-server — see /tmp/llama-server.log"; exit 1

# pidfile-targeted kill only: never touch llama-server processes this
# project didn't start (the health check below reports leftovers)
stop:
	@if [ -s /tmp/llama-server.pid ]; then \
		kill -9 $$(cat /tmp/llama-server.pid) 2>/dev/null || true; \
	fi; \
	rm -f /tmp/llama-server.pid; \
	rm -f /tmp/llama-server.managed; \
	sleep 1; \
	if curl -s -m 2 http://$(LLM_HOST):$(LLM_PORT)/health >/dev/null 2>&1; then \
		echo "llama-server still running on :$(LLM_PORT) — kill it manually"; \
		exit 1; \
	else \
		echo "stopped"; \
	fi

llm-stop: stop

llm-status:
	@curl -s -m 3 http://$(LLM_HOST):$(LLM_PORT)/health && echo " (llama-server ok)" || echo "llama-server unreachable"
	@nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader 2>/dev/null || true

# ── quality gates ────────────────────────────────────────────────────────────
test:
	bunx vitest run

check:
	bun run typecheck
	bun run lint
	bun run format:check

format:
	bun run format

build:
	bun run build

start:
	bun run start