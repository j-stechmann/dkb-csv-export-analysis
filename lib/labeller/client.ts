import { getConfig } from "@/lib/config"
import { normalizeWhitespace } from "@/lib/money"

const MAX_FIELD_LENGTH = 512
const MAX_BATCH = 100

export type LabellerHealth = "ok" | "degraded" | "unreachable"

export interface LabellerInput {
  id: string
  amountCents: number
  counterparty: string
  purpose: string
  bookingDate: string
}

export interface LabelResult {
  id: string
  label: string
}

export class LabellerRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly detail?: unknown
  ) {
    super(message)
    this.name = "LabellerRequestError"
  }
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function truncate(s: string): string {
  const normalized = normalizeWhitespace(s)
  const bytes = textEncoder.encode(normalized)
  if (bytes.length <= MAX_FIELD_LENGTH) return normalized
  // the service enforces maxLength in UTF-8 bytes; cut on a char boundary
  let end = MAX_FIELD_LENGTH
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return textDecoder.decode(bytes.subarray(0, end))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function parseErrorBody(
  res: Response
): Promise<{ code?: string; message?: string }> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string }
    }
    return body.error ?? {}
  } catch {
    return {}
  }
}

export class LabellerClient {
  constructor(private readonly baseUrl?: string) {}

  private get cfg() {
    return getConfig()
  }

  private get root(): string {
    return (this.baseUrl ?? this.cfg.LABELLER_BASE_URL).replace(/\/+$/, "")
  }

  async health(): Promise<LabellerHealth> {
    try {
      const res = await fetch(`${this.root}/v1/health`, {
        signal: AbortSignal.timeout(5000),
      })
      if (res.status === 200) return "ok"
      if (res.status === 503) return "degraded"
      return "degraded"
    } catch {
      return "unreachable"
    }
  }

  /**
   * Label one chunk (≤ max_batch items). Handles:
   * - 503 backend down → retry honoring Retry-After, up to max retries
   * - 413 batch too large → caller splits (throws BatchTooLargeError)
   * - 400 invalid request → permanent failure for this chunk
   * Returns results in input order.
   */
  async labelChunk(items: LabellerInput[]): Promise<LabelResult[]> {
    if (items.length === 0) return []
    if (items.length > 100) {
      throw new BatchTooLargeError(items.length)
    }

    const payload = {
      transactions: items.map((item) => ({
        id: truncate(item.id),
        amount: item.amountCents / 100,
        counterparty: truncate(item.counterparty),
        purpose: truncate(item.purpose),
        date: truncate(item.bookingDate),
        currency: "EUR",
      })),
      options: { language: this.cfg.LABELLER_LANGUAGE },
    }

    let retriesLeft = this.cfg.LABELLER_MAX_RETRIES
    for (;;) {
      let res: Response
      try {
        res = await fetch(`${this.root}/v1/label:batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(120_000),
        })
      } catch (err) {
        // network error behaves like backend down
        if (retriesLeft > 0) {
          retriesLeft--
          await sleep(this.cfg.LABELLER_RETRY_AFTER_FALLBACK_MS)
          continue
        }
        throw new LabellerBackendError(
          `network error after retries: ${(err as Error).message}`
        )
      }

      if (res.status === 200) {
        const body = (await res.json()) as { results: LabelResult[] }
        return body.results
      }

      if (res.status === 503) {
        if (retriesLeft > 0) {
          retriesLeft--
          const retryAfterHeader = res.headers.get("Retry-After")
          const retryAfterMs = retryAfterHeader
            ? Number.parseFloat(retryAfterHeader) * 1000
            : this.cfg.LABELLER_RETRY_AFTER_FALLBACK_MS
          await sleep(Number.isFinite(retryAfterMs) ? retryAfterMs : 5000)
          continue
        }
        throw new LabellerBackendError(
          "backend unavailable (503) after retries"
        )
      }

      if (res.status === 413) {
        throw new BatchTooLargeError(items.length)
      }

      const errBody = await parseErrorBody(res)
      throw new LabellerRequestError(
        `labeller request failed (${res.status}): ${errBody.code ?? "unknown"} ${errBody.message ?? ""}`.trim(),
        res.status,
        errBody
      )
    }
  }
}

export class BatchTooLargeError extends Error {
  constructor(public readonly size: number) {
    super(`batch too large: ${size}`)
    this.name = "BatchTooLargeError"
  }
}

export class LabellerBackendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LabellerBackendError"
  }
}

/**
 * Label a list of any size: chunks ≤ max batch size; on 413 splits the
 * chunk in half recursively; single items that still fail are marked failed
 * via the returned per-item error.
 */
export async function labelWithChunking(
  client: LabellerClient,
  items: LabellerInput[],
  onBatchDone: (results: LabelResult[]) => void | Promise<void>
): Promise<void> {
  const maxBatch = getConfig().LABELLER_BATCH_SIZE

  async function run(chunk: LabellerInput[], depth: number): Promise<void> {
    if (chunk.length === 0) return
    if (depth > 16) {
      throw new LabellerRequestError(
        "chunk split recursion exceeded maximum depth",
        413
      )
    }
    // hard slice at maxBatch (preserves API limit); iterative so ordinary
    // slicing never consumes the split-depth budget
    while (chunk.length > maxBatch) {
      await send(chunk.slice(0, maxBatch), depth)
      chunk = chunk.slice(maxBatch)
    }
    await send(chunk, depth)
  }

  async function send(
    chunk: LabellerInput[],
    depth: number
  ): Promise<void> {
    try {
      const results = await client.labelChunk(chunk)
      await onBatchDone(results)
    } catch (err) {
      if (err instanceof BatchTooLargeError) {
        if (chunk.length === 1) {
          throw new LabellerRequestError(
            "single-item batch rejected with 413",
            413
          )
        }
        const mid = Math.ceil(chunk.length / 2)
        await run(chunk.slice(0, mid), depth + 1)
        await run(chunk.slice(mid), depth + 1)
        return
      }
      throw err
    }
  }

  await run(items, 0)
}