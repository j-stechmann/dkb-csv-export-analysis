import { getConfig, type AppConfig } from "@/lib/config"
import {
  responseSchema,
  systemPrompt,
  truncateField,
  userPrompt,
  type PromptTransaction,
} from "@/lib/llm/prompt"

export type LlmHealth = "ok" | "degraded" | "unreachable"

/** One result per input transaction, in input order. */
export interface LabelResult {
  id: string
  label: string
}

/** Error classification mirroring the ported Rust retry semantics. */
export class LlmTimeoutError extends Error {
  constructor(ms: number) {
    super(`LLM request timed out after ${ms}ms`)
    this.name = "LlmTimeoutError"
  }
}

export class LlmUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LlmUnreachableError"
  }
}

export class LlmHttpError extends Error {
  constructor(
    public readonly status: number,
    body: string
  ) {
    super(`LLM HTTP ${status}: ${body.slice(0, 500)}`)
    this.name = "LlmHttpError"
  }
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

interface ChatBody {
  messages: Array<{ role: string; content: string }>
  temperature: number
  max_tokens: number
  response_format: {
    type: "json_schema"
    json_schema: { schema: Record<string, unknown> }
  }
}

export class LlmClient {
  constructor(private readonly baseUrl?: string) {}

  private get cfg(): AppConfig {
    return getConfig()
  }

  private get root(): string {
    return (this.baseUrl ?? this.cfg.LLM_BASE_URL).replace(/\/+$/, "")
  }

  /** Cheap reachability probe used as the worker's health gate. */
  async health(): Promise<LlmHealth> {
    try {
      const res = await fetch(`${this.root}/health`, {
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) return "ok"
      return "degraded"
    } catch {
      return "unreachable"
    }
  }

  /**
   * Label one batch against llama-server. Returns results positionally
   * (results[k] ↔ items[k], missing slots omitted). Transient failures
   * (network, 429, 5xx) are retried with exponential backoff; a timeout is
   * NOT retried — it throws LlmTimeoutError so the caller marks claimed rows
   * failed (there are no fallback labels).
   */
  async labelBatch(
    items: PromptTransaction[],
    existingLabels: string[] = []
  ): Promise<LabelResult[]> {
    if (items.length === 0) return []

    const cfg = this.cfg
    const body: ChatBody = {
      messages: [
        {
          role: "system",
          content: systemPrompt(cfg.LLM_LANGUAGE, existingLabels),
        },
        { role: "user", content: userPrompt(items) },
      ],
      temperature: 0,
      max_tokens: Math.max(1024, items.length * 24),
      response_format: {
        type: "json_schema",
        json_schema: { schema: responseSchema() },
      },
    }

    let retriesLeft = cfg.LLM_MAX_RETRIES
    for (;;) {
      let res: Response
      try {
        res = await this.chat(body)
      } catch (err) {
        // AbortSignal.timeout() rejects fetch with a DOMException named
        // "TimeoutError" — timeouts are NOT retried (no fallback labels:
        // the caller marks the claimed rows failed)
        if (err instanceof DOMException && err.name === "TimeoutError") {
          throw new LlmTimeoutError(this.cfg.LLM_TIMEOUT_MS)
        }
        if (err instanceof LlmTimeoutError) throw err
        // network error behaves like backend down (transient)
        if (retriesLeft > 0) {
          retriesLeft--
          await sleep(backoffMs(retriesLeft))
          continue
        }
        throw new LlmUnreachableError((err as Error).message)
      }

      if (res.ok) {
        return this.parseChatResponse(res, items)
      }

      if (res.status === 429 || res.status >= 500) {
        if (retriesLeft > 0) {
          retriesLeft--
          await sleep(backoffMs(retriesLeft))
          continue
        }
        throw new LlmHttpError(res.status, await safeBody(res))
      }

      throw new LlmHttpError(res.status, await safeBody(res))
    }
  }

  private async chat(body: ChatBody): Promise<Response> {
    return fetch(`${this.root}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.LLM_TIMEOUT_MS),
    })
  }

  /**
   * Positional association: results[k] ↔ items[k]. The model-echoed index is
   * never trusted; first valid label per slot wins, duplicate/empty labels
   * skipped, extra results dropped. Missing slots are simply absent from the
   * output — the caller decides (mark failed), keeping "no fallback labels".
   */
  private async parseChatResponse(
    res: Response,
    items: PromptTransaction[]
  ): Promise<LabelResult[]> {
    const payload = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string } }>
    } | null
    const content = payload?.choices?.[0]?.message?.content
    if (typeof content !== "string") {
      throw new LlmHttpError(res.status, "response missing message content")
    }
    const parsed = extractJson(content)
    if (!parsed) {
      throw new LlmHttpError(res.status, "no valid JSON object in response")
    }
    const results = parsed.results
    if (!Array.isArray(results)) {
      throw new LlmHttpError(res.status, "missing results array")
    }

    const out: LabelResult[] = []
    for (const entry of results) {
      if (out.length >= items.length) break
      if (!entry || typeof entry !== "object") continue
      const label = (entry as { label?: unknown }).label
      if (typeof label !== "string") continue
      const cleaned = sanitizeLabel(label)
      if (!cleaned) continue
      out.push({ id: items[out.length].id, label: cleaned })
    }
    return out
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 200ms · 4^(attempt-1) + jitter [0, base/4] — ported from the Rust client. */
function backoffMs(attempt: number): number {
  const base = 200 * 4 ** (attempt - 1)
  return base + Math.random() * (base / 4)
}

async function safeBody(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

/**
 * Extracts a JSON object from model output: successive `{` candidates,
 * balanced-brace scan respecting string escapes, first full parse wins.
 * Ported from the Rust `extract_json`/`balanced_object`.
 */
export function extractJson(text: string): { results?: unknown } | null {
  const start = text.indexOf("{")
  if (start === -1) return null
  for (let pos = start; pos < text.length; pos++) {
    if (text[pos] !== "{") continue
    const candidate = balancedObject(text, pos)
    if (candidate === null) continue
    try {
      return JSON.parse(candidate) as { results?: unknown }
    } catch {
      // prose-poisoned candidate; try the next brace
    }
  }
  return null
}

function balancedObject(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (c === "\\") {
        escaped = true
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      inString = true
    } else if (c === "{") {
      depth++
    } else if (c === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** trim → collapse whitespace → drop control chars → cap at 64 UTF-8 bytes. */
export function sanitizeLabel(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim()
  const noControls = collapsed
    .split("")
    .filter((c) => {
      const code = c.codePointAt(0) ?? 0
      return code >= 0x20 && code !== 0x7f
    })
    .join("")
    .trim()
  if (!noControls) return ""
  const bytes = textEncoder.encode(noControls)
  if (bytes.length <= 64) return noControls
  let end = 64
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return textDecoder.decode(bytes.subarray(0, end)).trim()
}

/** Truncated prompt transaction for transport-size safety. */
export function toPromptTransaction(
  item: PromptTransaction
): PromptTransaction {
  return {
    id: truncateField(item.id),
    amountCents: item.amountCents,
    counterparty: truncateField(item.counterparty),
    purpose: truncateField(item.purpose),
    bookingDate: truncateField(item.bookingDate),
    suggestions: item.suggestions.map((s) => truncateField(s)),
  }
}
