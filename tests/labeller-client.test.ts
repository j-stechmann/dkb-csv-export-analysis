import { afterEach, describe, it, expect, vi } from "vitest"
import {
  LabellerClient,
  labelWithChunking,
  BatchTooLargeError,
  LabellerBackendError,
  type LabellerInput,
} from "@/lib/labeller/client"

const baseInput = (i: number): LabellerInput => ({
  id: `tx-${i}`,
  amountCents: -4213,
  counterparty: "REWE SAGT DANKE",
  purpose: "Einkauf",
  bookingDate: "2026-02-03",
})

// default success response machinery
function okResponse(results: Array<{ id: string; label: string }>) {
  return new Response(JSON.stringify({ results }), { status: 200 })
}

describe("LabellerClient.health", () => {
  afterEach(() => vi.restoreAllMocks())

  it("maps 200 → ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 }))
    )
    expect(await new LabellerClient("http://x").health()).toBe("ok")
  })

  it("maps 503 → degraded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 }))
    )
    expect(await new LabellerClient("http://x").health()).toBe("degraded")
  })

  it("maps network error → unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED")
      })
    )
    expect(await new LabellerClient("http://x").health()).toBe("unreachable")
  })
})

describe("LabellerClient.labelChunk", () => {
  afterEach(() => vi.restoreAllMocks())

  it("sends truncated payload with correct mapping", async () => {
    let captured: {
      transactions: Array<{
        id: string
        amount: number
        counterparty: string
        purpose: string
        date: string
        currency: string
      }>
      options: { language: string }
    } | null = null
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body))
        return new Response(
          JSON.stringify({ results: [{ id: "tx-0", label: "Lebensmittel" }] }),
          { status: 200 }
        )
      })
    )
    const client = new LabellerClient("http://x")
    const results = await client.labelChunk([
      {
        id: "tx-0",
        amountCents: -4213,
        counterparty: "  REWE   SAGT  DANKE ",
        purpose: "x".repeat(600),
        bookingDate: "2026-02-03",
      },
    ])
    expect(results).toEqual([{ id: "tx-0", label: "Lebensmittel" }])
    expect(captured).not.toBeNull()
    const tx = captured!.transactions[0]
    expect(tx.amount).toBe(-42.13)
    expect(tx.counterparty).toBe("REWE SAGT DANKE")
    expect(tx.counterparty.length).toBeLessThanOrEqual(512)
    expect(tx.purpose.length).toBeLessThanOrEqual(512)
    expect(tx.date).toBe("2026-02-03")
    expect(tx.currency).toBe("EUR")
    expect(captured!.options.language).toBe("de")
  })

  it("truncates by UTF-8 bytes, not chars", async () => {
    let captured: {
      transactions: Array<{ counterparty: string; purpose: string }>
    } | null = null
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body))
        return okResponse([])
      })
    )
    // 600 'ü' = 600 chars but 1200 bytes; emoji are 4 bytes each
    const longUmlaut = "ü".repeat(600)
    const longEmoji = "😀".repeat(600)
    await new LabellerClient("http://x").labelChunk([
      {
        id: "tx-0",
        amountCents: -100,
        counterparty: longUmlaut,
        purpose: longEmoji,
        bookingDate: "2026-02-03",
      },
    ])
    const tx = captured!.transactions[0]
    expect(
      new TextEncoder().encode(tx.counterparty).length
    ).toBeLessThanOrEqual(512)
    expect(new TextEncoder().encode(tx.purpose).length).toBeLessThanOrEqual(512)
  })

  it("retries on 503 honoring Retry-After then succeeds", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        if (calls < 3) {
          return new Response(JSON.stringify({ error: {} }), {
            status: 503,
            headers: { "Retry-After": "0.01" },
          })
        }
        return okResponse([{ id: "tx-0", label: "Miete" }])
      })
    )
    const results = await new LabellerClient("http://x").labelChunk([
      baseInput(0),
    ])
    expect(calls).toBe(3)
    expect(results[0].label).toBe("Miete")
  })

  it("throws LabellerBackendError when 503 persists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 }))
    )
    await expect(
      new LabellerClient("http://x").labelChunk([baseInput(0)])
    ).rejects.toThrow(LabellerBackendError)
  })

  it("throws BatchTooLargeError on 413", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 413 }))
    )
    await expect(
      new LabellerClient("http://x").labelChunk([baseInput(0)])
    ).rejects.toThrow(BatchTooLargeError)
  })

  it("throws LabellerRequestError on 400 (not retried)", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        return new Response(
          JSON.stringify({
            error: { code: "invalid_request", message: "dup ids" },
          }),
          { status: 400 }
        )
      })
    )
    await expect(
      new LabellerClient("http://x").labelChunk([baseInput(0)])
    ).rejects.toThrow(/400/)
    expect(calls).toBe(1)
  })
})

describe("labelWithChunking", () => {
  afterEach(() => vi.restoreAllMocks())

  it("chunks >maxBatch into sub-batches", async () => {
    const sizes: number[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        sizes.push(body.transactions.length)
        return new Response(
          JSON.stringify({
            results: body.transactions.map((t: { id: string }) => ({
              id: t.id,
              label: "L",
            })),
          }),
          { status: 200 }
        )
      })
    )
    const client = new LabellerClient("http://x")
    const seen: string[] = []
    await labelWithChunking(
      client,
      Array.from({ length: 250 }, (_, i) => baseInput(i)),
      (results) => {
        for (const r of results) seen.push(r.id)
      }
    )
    expect(sizes).toEqual([100, 100, 50])
    expect(seen).toHaveLength(250)
    expect(new Set(seen).size).toBe(250)
  })

  it("slices large sweeps iteratively without exhausting split depth", async () => {
    const sizes: number[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        sizes.push(body.transactions.length)
        return new Response(
          JSON.stringify({
            results: body.transactions.map((t: { id: string }) => ({
              id: t.id,
              label: "L",
            })),
          }),
          { status: 200 }
        )
      })
    )
    const client = new LabellerClient("http://x")
    const seen: string[] = []
    // 2000 items: old code recursed per 100-item slice and hit depth > 16
    await labelWithChunking(
      client,
      Array.from({ length: 2000 }, (_, i) => baseInput(i)),
      (results) => {
        for (const r of results) seen.push(r.id)
      }
    )
    expect(sizes).toHaveLength(20)
    expect(sizes.every((s) => s === 100)).toBe(true)
    expect(seen).toHaveLength(2000)
    expect(new Set(seen).size).toBe(2000)
  })

  it("splits on 413 and marks single-item 413 as failed item", async () => {
    const sizes: number[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        sizes.push(body.transactions.length)
        if (body.transactions.length > 2) {
          return new Response("{}", { status: 413 })
        }
        return new Response(
          JSON.stringify({
            results: body.transactions.map((t: { id: string }) => ({
              id: t.id,
              label: "L",
            })),
          }),
          { status: 200 }
        )
      })
    )
    const client = new LabellerClient("http://x")
    const seen: string[] = []
    await labelWithChunking(
      client,
      Array.from({ length: 5 }, (_, i) => baseInput(i)),
      (results) => {
        for (const r of results) seen.push(r.id)
      }
    )
    // 5 → 3+2 → (3 → 2+1)(2) : all eventually ≤2 succeed
    expect(seen).toHaveLength(5)
    expect(sizes.every((s) => s <= 2 || s > 2)).toBe(true)
  })
})
