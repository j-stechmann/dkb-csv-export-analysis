import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { resetConfigCache } from "@/lib/config"
import {
  LlmClient,
  LlmHttpError,
  LlmTimeoutError,
  LlmUnreachableError,
  extractJson,
  sanitizeLabel,
  toPromptTransaction,
} from "@/lib/llm/client"
import type { PromptTransaction } from "@/lib/llm/prompt"

beforeEach(() => {
  // setup.ts pins LLM_MAX_RETRIES=0 for worker tests; retry tests need 2
  process.env.LLM_MAX_RETRIES = "2"
  resetConfigCache()
})

afterEach(() => {
  delete process.env.LLM_MAX_RETRIES
  resetConfigCache()
})

function chatResponse(content: unknown, status = 200): Response {
  const contentStr =
    typeof content === "string" ? content : JSON.stringify(content)
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: contentStr } }],
    }),
    { status }
  )
}

function tx(overrides: Partial<PromptTransaction> = {}): PromptTransaction {
  return {
    id: "tx-1",
    amountCents: -1000,
    counterparty: "REWE",
    purpose: "Einkauf",
    bookingDate: "2026-02-14",
    suggestions: [],
    ...overrides,
  }
}

describe("LlmClient.labelBatch", () => {
  afterEach(() => vi.restoreAllMocks())

  it("parses a clean positional response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse({
          results: [
            { index: 0, label: "Lebensmittel" },
            { index: 1, label: "Miete" },
          ],
        })
      )
    )

    const out = await new LlmClient("http://test").labelBatch([
      tx({ id: "a" }),
      tx({ id: "b" }),
    ])

    expect(out).toEqual([
      { id: "a", label: "Lebensmittel" },
      { id: "b", label: "Miete" },
    ])
  })

  it("maps results positionally, ignoring echoed indices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse({
          results: [
            { index: 7, label: "Lebensmittel" },
            { index: 3, label: "Miete" },
          ],
        })
      )
    )

    const out = await new LlmClient("http://test").labelBatch([
      tx({ id: "a" }),
      tx({ id: "b" }),
    ])
    expect(out.map((r) => r.label)).toEqual(["Lebensmittel", "Miete"])
  })

  it("drops invalid/empty labels and extra results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse({
          results: [
            { index: 0, label: "   " },
            { index: 1, label: "Miete" },
            { index: 9, label: "Extra" },
            { label: 42 },
          ],
        })
      )
    )

    const out = await new LlmClient("http://test").labelBatch([
      tx({ id: "a" }),
      tx({ id: "b" }),
    ])
    // positional first-valid-wins: "Miete" fills slot 0, "Extra" slot 1;
    // empty labels and non-string entries are skipped
    expect(out).toEqual([
      { id: "a", label: "Miete" },
      { id: "b", label: "Extra" },
    ])
  })

  it("extracts JSON from prose-poisoned output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatResponse(
          'Here you go: {"results":[{"index":0,"label":"Miete \\"x\\""}]} hope this helps!'
        )
      )
    )

    const out = await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
    expect(out).toEqual([{ id: "a", label: 'Miete "x"' }])
  })

  it("throws LlmHttpError when no JSON is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => chatResponse("no json at all"))
    )

    await expect(
      new LlmClient("http://test").labelBatch([tx()])
    ).rejects.toBeInstanceOf(LlmHttpError)
  })

  it("retries transient 5xx and succeeds", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        return calls === 1
          ? new Response("boom", { status: 503 })
          : chatResponse({ results: [{ index: 0, label: "Miete" }] })
      })
    )

    const out = await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
    expect(out).toEqual([{ id: "a", label: "Miete" }])
    expect(calls).toBe(2)
  })

  it("retries 429 with backoff and succeeds", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        return calls === 1
          ? new Response("slow down", { status: 429 })
          : chatResponse({ results: [{ index: 0, label: "Miete" }] })
      })
    )

    const out = await new LlmClient("http://test").labelBatch([tx({ id: "a" })])
    expect(out).toHaveLength(1)
  })

  it("fails after exhausting retries on 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 500 }))
    )

    await expect(
      new LlmClient("http://test").labelBatch([tx()])
    ).rejects.toBeInstanceOf(LlmHttpError)
  })

  it("does NOT retry timeouts (no fallback labels)", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            calls++
            const signal = init?.signal as AbortSignal
            signal.addEventListener("abort", () =>
              calls > 0 ? void 0 : undefined
            )
            setTimeout(() => {
              reject(new DOMException("timeout", "TimeoutError"))
            }, 10)
          })
      )
    )

    await expect(
      new LlmClient("http://test").labelBatch([tx()])
    ).rejects.toBeInstanceOf(LlmTimeoutError)
    expect(calls).toBe(1)
  })

  it("retries network errors then throws unreachable", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++
        throw new Error("ECONNREFUSED")
      })
    )

    await expect(
      new LlmClient("http://test").labelBatch([tx()])
    ).rejects.toBeInstanceOf(LlmUnreachableError)
    expect(calls).toBe(3) // 1 + LLM_MAX_RETRIES=2
  })

  it("sends json_schema response format with temperature 0", async () => {
    let captured: unknown
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        captured = JSON.parse(String(init?.body))
        return chatResponse({ results: [{ index: 0, label: "Miete" }] })
      })
    )

    await new LlmClient("http://test").labelBatch(
      [tx()],
      ["Lebensmittel", "Miete"]
    )

    const body = captured as {
      messages: Array<{ role: string; content: string }>
      temperature: number
      max_tokens: number
      response_format: { type: string }
    }
    expect(body.temperature).toBe(0)
    expect(body.response_format.type).toBe("json_schema")
    expect(body.messages[0].content).toContain("Lebensmittel")
    expect(body.messages[0].content).toContain("Miete")
    // dynamic max_tokens for a batch of 1 stays at the floor
    expect(body.max_tokens).toBe(1024)
  })

  it("scales max_tokens with the batch size", async () => {
    let captured: unknown
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        captured = JSON.parse(String(init?.body))
        return chatResponse({
          results: Array.from({ length: 100 }, (_, i) => ({
            index: i,
            label: "X",
          })),
        })
      })
    )

    const items = Array.from({ length: 100 }, (_, i) => tx({ id: `t${i}` }))
    await new LlmClient("http://test").labelBatch(items)
    expect((captured as { max_tokens: number }).max_tokens).toBe(9600)
  })
})

describe("LlmClient.health", () => {
  afterEach(() => vi.restoreAllMocks())

  it("reports ok on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 }))
    )
    expect(await new LlmClient("http://test").health()).toBe("ok")
  })

  it("reports unreachable on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("nope")
      })
    )
    expect(await new LlmClient("http://test").health()).toBe("unreachable")
  })
})

describe("extractJson", () => {
  it("handles braces inside strings", () => {
    const out = extractJson('{"results":[{"index":0,"label":"a{b}c"}]}')
    expect(out).toEqual({ results: [{ index: 0, label: "a{b}c" }] })
  })

  it("returns null for garbage", () => {
    expect(extractJson("no object here")).toBeNull()
    expect(extractJson("{not json")).toBeNull()
  })
})

describe("sanitizeLabel", () => {
  it("trims, collapses whitespace, strips controls, caps at 64 bytes", () => {
    expect(sanitizeLabel("  Lebensmittel  ")).toBe("Lebensmittel")
    expect(sanitizeLabel("a\u0007b   c")).toBe("ab c")
    expect(sanitizeLabel("ä".repeat(64)).length).toBeLessThan(64)
    expect(new TextEncoder().encode(sanitizeLabel("ä".repeat(64))).length).toBe(
      64
    )
    expect(sanitizeLabel("   ")).toBe("")
  })
})

describe("toPromptTransaction", () => {
  it("truncates oversized fields", () => {
    const out = toPromptTransaction(
      tx({ purpose: "x".repeat(600), counterparty: "ä".repeat(600) })
    )
    expect(out.purpose.length).toBeLessThanOrEqual(512)
    expect(
      new TextEncoder().encode(out.counterparty).length
    ).toBeLessThanOrEqual(512)
  })

  it("keeps suggestions and truncates each", () => {
    const out = toPromptTransaction(
      tx({ suggestions: ["Miete", "y".repeat(600)] })
    )
    expect(out.suggestions[0]).toBe("Miete")
    expect(out.suggestions[1].length).toBeLessThanOrEqual(512)
  })
})
