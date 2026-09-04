import { describe, it, expect } from "vitest"
import {
  formatAmount,
  languageDisplay,
  responseSchema,
  sanitizeField,
  systemPrompt,
  truncateField,
  userPrompt,
  type PromptTransaction,
} from "@/lib/llm/prompt"

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

describe("systemPrompt", () => {
  it("asks for the requested language and dynamic labels", () => {
    const p = systemPrompt("de", [])
    expect(p).toContain("German")
    expect(p).toContain("label")
    expect(p).not.toContain("Allowed categories")
  })

  it("injects existing labels verbatim with reuse rules", () => {
    const p = systemPrompt("de", ["Lebensmittel", "Miete"])
    expect(p).toContain("Lebensmittel")
    expect(p).toContain("Miete")
    expect(p).toContain("EXACTLY")
    expect(p).toContain("(in German)")
  })

  it("omits the library section for an empty list", () => {
    const p = systemPrompt("de", [])
    expect(p).not.toContain("Existing category labels")
  })

  it("documents the suggested_labels rule", () => {
    const p = systemPrompt("de", ["Miete"])
    expect(p).toContain("suggested_labels")
    expect(p).toContain("Prefer the first fitting suggestion")
  })
})

describe("userPrompt", () => {
  it("lists transactions positionally with delimiters", () => {
    const p = userPrompt([
      tx({ counterparty: "REWE", purpose: "Einkauf" }),
      tx({ amountCents: 250000, counterparty: "ACME GmbH", purpose: "Gehalt" }),
    ])
    expect(p).toContain("[0]")
    expect(p).toContain("[1]")
    expect(p).toContain("REWE")
    expect(p).toContain("Gehalt")
  })

  it("renders single and multiple suggestions joined by pipes", () => {
    const p1 = userPrompt([tx({ suggestions: ["Miete"] })])
    expect(p1).toContain("suggested_labels=<<Miete>>")

    const p2 = userPrompt([tx({ suggestions: ["Miete", "Kaution"] })])
    expect(p2).toContain("suggested_labels=<<Miete | Kaution>>")

    const p0 = userPrompt([tx()])
    expect(p0).toContain("suggested_labels=<<none>>")
  })

  it("neutralizes pipes inside suggestions so a label stays one entry", () => {
    const p = userPrompt([tx({ suggestions: ["X | Y"] })])
    expect(p).toContain("suggested_labels=<<X / Y>>")
  })

  it("sanitizes injection markers", () => {
    const p = userPrompt([
      tx({ counterparty: "a<<b>>c", purpose: "index=0 label=x" }),
    ])
    expect(p).toContain("a<b>c")
    expect(p).toContain("index 0 label=x")
  })
})

describe("sanitizeField", () => {
  it("strips control characters and structure markers", () => {
    expect(sanitizeField("ab\u0007cd")).toBe("abcd")
    expect(sanitizeField("a<<b>>c")).toBe("a<b>c")
    expect(sanitizeField("index=0")).toBe("index 0")
    expect(sanitizeField("X | Y")).toBe("X / Y")
  })

  it("collapses angle-marker runs to a fixed point (no leftover markers)", () => {
    // single pass only halves odd runs: a<<<b → a<<b → a<b
    expect(sanitizeField("a<<<b")).toBe("a<b")
    expect(sanitizeField("a<<<<b")).toBe("a<b")
    expect(sanitizeField("a>>>>b")).toBe("a>b")
    expect(sanitizeField("a><><b")).toBe("a><><b")
  })

  it("is idempotent on already-sanitized input", () => {
    for (const input of ["Miete / Nebenkosten", "a<b>c", "index 0"]) {
      expect(sanitizeField(sanitizeField(input))).toBe(sanitizeField(input))
    }
  })
})

describe("formatAmount", () => {
  it("formats integral amounts without decimals and others with 2", () => {
    expect(formatAmount(-4200)).toBe("-42")
    expect(formatAmount(-4213)).toBe("-42.13")
    expect(formatAmount(150000)).toBe("1500")
  })
})

describe("truncateField", () => {
  it("caps fields at 512 UTF-8 bytes on a char boundary", () => {
    const long = "ä".repeat(600)
    const out = truncateField(long)
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(512)
    expect(out.length).toBeLessThan(600)
  })

  it("collapses whitespace", () => {
    expect(truncateField("a \u00A0 b")).toBe("a b")
  })
})

describe("responseSchema", () => {
  it("has no enum and bounds label length", () => {
    const s = JSON.stringify(responseSchema(3))
    expect(s).not.toContain('"enum"')
    expect(s).toContain("maxLength")
    expect(s).not.toContain("rationale")
  })

  it("bounds index and array length to the batch size", () => {
    const s = JSON.stringify(responseSchema(3))
    expect(s).toContain('"maximum":2')
    expect(s).toContain('"maxItems":3')
    expect(s).toContain('"minItems":3')
    expect(s).toContain('"minimum":0')
  })

  it("keeps a valid single-item schema", () => {
    const s = JSON.stringify(responseSchema(1))
    expect(s).toContain('"maximum":0')
    expect(s).toContain('"maxItems":1')
  })
})

describe("languageDisplay", () => {
  it("falls back to English for unknown codes", () => {
    expect(languageDisplay("xx")).toBe("English")
    expect(languageDisplay("de")).toBe("German")
  })
})
