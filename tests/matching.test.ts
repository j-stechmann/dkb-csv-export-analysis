import { describe, it, expect, beforeEach } from "vitest"
import { eq } from "drizzle-orm"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import { accounts, categories, labelRules } from "@/lib/db/schema"
import {
  learnRule,
  resolveLabelNames,
  suggestForBatch,
  suggestLabelIds,
} from "@/lib/labels/matching"
import { resetConfigCache } from "@/lib/config"

const IBAN = "DE02120300000000202051"

let db: Db

function cat(name: string, origin = "manual", usageCount = 0): number {
  const existing = db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.nameKey, name.toLowerCase()))
    .get()
  if (existing) return existing.id
  return db
    .insert(categories)
    .values({
      name,
      nameKey: name.toLowerCase(),
      language: "de",
      origin,
      usageCount,
    })
    .returning()
    .get().id
}

function rule(
  labelId: number,
  iban: string,
  nameKey: string,
  createdAt = new Date().toISOString()
): number {
  return db
    .insert(labelRules)
    .values({
      labelId,
      iban,
      nameKey,
      name: nameKey,
      createdAt,
      updatedAt: createdAt,
    })
    .returning()
    .get().id
}

beforeEach(() => {
  db = createTestDb()
  setTestDb(db)
  db.insert(accounts).values({ iban: IBAN, name: "Girokonto" }).run()
  resetConfigCache()
})

describe("suggestLabelIds", () => {
  it("returns rules for an exact IBAN match", () => {
    const miete = cat("Miete")
    rule(miete, IBAN, "vermieter")

    expect(suggestLabelIds(db, " de02 1203 0000 0000 2020 51 ")).toEqual([
      miete,
    ])
  })

  it("returns nothing without a rule match", () => {
    expect(suggestLabelIds(db, IBAN)).toEqual([])
    expect(suggestLabelIds(db, null)).toEqual([])
    expect(suggestLabelIds(db, "")).toEqual([])
  })

  it("ranks by usageCount desc, manual before llm, newest first", () => {
    const old = new Date(Date.now() - 60_000).toISOString()
    const now = new Date().toISOString()

    const llmLow = cat("LlmLow", "llm", 1)
    const manualLow = cat("ManualLow", "manual", 1)
    const llmHigh = cat("LlmHigh", "llm", 5)
    const manualHigh = cat("ManualHigh", "manual", 5)

    // same usage, manual beats llm; same usage+origin, newest wins
    rule(llmLow, IBAN, "llm-low", old)
    rule(manualLow, IBAN, "manual-low", now)
    rule(llmHigh, IBAN, "llm-high", old)
    rule(manualHigh, IBAN, "manual-high", now)

    expect(suggestLabelIds(db, IBAN)).toEqual([manualHigh, llmHigh, manualLow])
  })

  it("dedupes by label and caps at LLM_MAX_SUGGESTIONS", () => {
    process.env.LLM_MAX_SUGGESTIONS = "2"
    resetConfigCache()

    const a = cat("A", "llm", 5)
    const b = cat("B", "llm", 4)
    const c = cat("C", "llm", 3)
    // two rules (different nameKeys) pointing at label A — deduped
    rule(a, IBAN, "rendering-1")
    rule(a, IBAN, "rendering-2")
    rule(b, IBAN, "rendering-3")
    rule(c, IBAN, "rendering-4")

    expect(suggestLabelIds(db, IBAN)).toEqual([a, b])
    delete process.env.LLM_MAX_SUGGESTIONS
    resetConfigCache()
  })
})

describe("suggestForBatch", () => {
  it("maps suggestions per transaction and queries each IBAN once", () => {
    const miete = cat("Miete")
    rule(miete, IBAN, "vermieter")

    const result = suggestForBatch([
      { counterpartyIban: IBAN },
      { counterpartyIban: IBAN },
      { counterpartyIban: null },
      { counterpartyIban: "DE00UNMATCHED00000000" },
    ])

    expect(result.get(0)).toEqual([miete])
    expect(result.get(1)).toEqual([miete])
    expect(result.get(2)).toEqual([])
    expect(result.get(3)).toEqual([])
  })
})

describe("learnRule", () => {
  it("inserts a rule with normalized keys and display name", () => {
    const miete = cat("Miete")
    const id = learnRule(db, {
      counterpartyIban: " de02 1203 0000 0000 2020 51 ",
      counterpartyName: "Vermieter GmbH",
      labelId: miete,
    })

    expect(id).not.toBeNull()
    const row = db.select().from(labelRules).all()[0]
    expect(row.iban).toBe(IBAN)
    expect(row.nameKey).toBe("vermieter")
    expect(row.name).toBe("Vermieter GmbH")
    expect(row.labelId).toBe(miete)
  })

  it("upserts: re-assigning the same rendering replaces the label", () => {
    const miete = cat("Miete")
    const kaution = cat("Kaution")
    learnRule(db, {
      counterpartyIban: IBAN,
      counterpartyName: "Vermieter",
      labelId: miete,
    })
    learnRule(db, {
      counterpartyIban: IBAN,
      counterpartyName: "vermieter gmbh",
      labelId: kaution,
    })

    const rules = db.select().from(labelRules).all()
    // "Vermieter" and "vermieter gmbh" normalize to the same key → replaced
    expect(rules).toHaveLength(1)
    expect(rules[0].labelId).toBe(kaution)
  })

  it("keeps sibling renderings as separate rules", () => {
    const miete = cat("Miete")
    learnRule(db, {
      counterpartyIban: IBAN,
      counterpartyName: "EDEKA",
      labelId: miete,
    })
    learnRule(db, {
      counterpartyIban: IBAN,
      counterpartyName: "EDEKA.SCHROT/ELXLEBEN",
      labelId: miete,
    })

    expect(db.select().from(labelRules).all()).toHaveLength(2)
  })

  it("rejects junk IBANs and empty names", () => {
    const miete = cat("Miete")
    expect(
      learnRule(db, {
        counterpartyIban: "IBAN123",
        counterpartyName: "X",
        labelId: miete,
      })
    ).toBeNull()
    expect(
      learnRule(db, {
        counterpartyIban: IBAN,
        counterpartyName: "   ",
        labelId: miete,
      })
    ).toBeNull()
    expect(
      learnRule(db, {
        counterpartyIban: null,
        counterpartyName: "X",
        labelId: miete,
      })
    ).toBeNull()
    expect(db.select().from(labelRules).all()).toHaveLength(0)
  })
})

describe("resolveLabelNames", () => {
  it("resolves ids to names and skips deleted labels", () => {
    const a = cat("Alpha")
    const b = cat("Beta")
    expect(resolveLabelNames(db, [a, b, 99999])).toEqual(
      new Map([
        [a, "Alpha"],
        [b, "Beta"],
      ])
    )
    expect(resolveLabelNames(db, [])).toEqual(new Map())
  })
})
