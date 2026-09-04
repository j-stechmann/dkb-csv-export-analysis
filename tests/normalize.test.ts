import { describe, it, expect } from "vitest"
import {
  counterpartyDisplayName,
  isLearnableIbanKey,
  normalizeCounterpartyKey,
  normalizeIbanKey,
} from "@/lib/db/normalize"

describe("normalizeIbanKey", () => {
  it("uppercases, strips whitespace and trims", () => {
    expect(normalizeIbanKey("de02 1203 0000 0000 2020 51")).toBe(
      "DE02120300000000202051"
    )
    expect(normalizeIbanKey("  DE02-1203 ")).toBe("DE02-1203")
  })

  it("keeps non-IBAN identifiers usable as stable keys", () => {
    expect(normalizeIbanKey("1056387457")).toBe("1056387457")
    expect(normalizeIbanKey("0000000000")).toBe("0000000000")
  })

  it("is null-safe", () => {
    expect(normalizeIbanKey(null)).toBe("")
    expect(normalizeIbanKey(undefined)).toBe("")
    expect(normalizeIbanKey("")).toBe("")
    expect(normalizeIbanKey("   ")).toBe("")
  })
})

describe("isLearnableIbanKey", () => {
  it("accepts real IBAN shapes", () => {
    expect(isLearnableIbanKey("DE02120300000000202051")).toBe(true)
    expect(isLearnableIbanKey("AT611904300234573201")).toBe(true)
  })

  it("accepts long numeric identifiers (GLN/card styles)", () => {
    expect(isLearnableIbanKey("1056387457")).toBe(true)
  })

  it("rejects placeholders and junk", () => {
    expect(isLearnableIbanKey("IBAN123")).toBe(false)
    expect(isLearnableIbanKey("0000000000")).toBe(false)
    expect(isLearnableIbanKey("DE02")).toBe(false)
    expect(isLearnableIbanKey("")).toBe(false)
  })
})

describe("normalizeCounterpartyKey", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeCounterpartyKey("  REWE   Markt  ")).toBe("rewe markt")
  })

  it("strips German legal forms", () => {
    expect(normalizeCounterpartyKey("Vermieter GmbH")).toBe("vermieter")
    expect(normalizeCounterpartyKey("Streaming AG")).toBe("streaming")
    expect(normalizeCounterpartyKey("Langtext UG (haftungsbeschränkt)")).toBe(
      "langtext haftungsbeschränkt"
    )
    expect(normalizeCounterpartyKey("RD-Invest GbR")).toBe("rd invest")
    expect(normalizeCounterpartyKey("Sportverein e.V.")).toBe("sportverein")
  })

  it("strips composite legal forms before bare ones", () => {
    expect(normalizeCounterpartyKey("Meyer GmbH & Co. KG")).toBe("meyer")
    expect(normalizeCounterpartyKey("Foo & Co. KGaA")).toBe("foo")
  })

  it("strips thank-you marketing suffixes", () => {
    expect(normalizeCounterpartyKey("REWE SAGT DANKE")).toBe("rewe")
    expect(normalizeCounterpartyKey("EDEKA DANKE")).toBe("edeka")
  })

  it("folds & to und and drops punctuation", () => {
    expect(normalizeCounterpartyKey("Nebendahl & Behrens")).toBe(
      "nebendahl und behrens"
    )
    expect(normalizeCounterpartyKey("Müller GmbH, Filiale 1")).toBe(
      "müller filiale 1"
    )
  })

  it("is null-safe", () => {
    expect(normalizeCounterpartyKey(null)).toBe("")
    expect(normalizeCounterpartyKey(undefined)).toBe("")
    expect(normalizeCounterpartyKey("")).toBe("")
  })
})

describe("counterpartyDisplayName", () => {
  it("normalizes unicode and whitespace without destroying the name", () => {
    expect(counterpartyDisplayName("  EDEKA\u00A0Markt ")).toBe(
      "EDEKA\u00A0Markt".replace("\u00A0", " ")
    )
    expect(counterpartyDisplayName(null)).toBe("")
  })
})
