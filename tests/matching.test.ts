import { describe, it, expect, beforeEach } from "vitest"
import { eq } from "drizzle-orm"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import { accounts, categories, labelRules } from "@/lib/db/schema"
import {
  learnRule,
  resolveLabelNames,
  ruleKeyFor,
  suggestForBatch,
  suggestLabelIds,
  type RuleKey,
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
  payerKey: string,
  payeeKey: string
): number {
  return db
    .insert(labelRules)
    .values({
      labelId,
      iban,
      payerKey,
      payeeKey,
      payer: payerKey.toUpperCase(),
      payee: payeeKey.toUpperCase(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .returning()
    .get().id
}

function key(
  iban: string | null,
  payer: string | null,
  payee: string | null
): RuleKey | null {
  return ruleKeyFor({ counterpartyIban: iban, payer, payee })
}

beforeEach(() => {
  db = createTestDb()
  setTestDb(db)
  db.insert(accounts).values({ iban: IBAN, name: "Girokonto" }).run()
  resetConfigCache()
})

describe("ruleKeyFor", () => {
  it("normalizes the tuple case/space-insensitively", () => {
    expect(
      key(" de02 1203 0000 0000 2020 51 ", "Vermieter GmbH", "Mieter AG")
    ).toEqual({
      ibanKey: IBAN,
      payerKey: "vermieter",
      payeeKey: "mieter",
    })
  })

  it("returns null when any component is unusable", () => {
    expect(key(null, "A", "B")).toBeNull()
    expect(key("", "A", "B")).toBeNull()
    expect(key(IBAN, null, "B")).toBeNull()
    expect(key(IBAN, "   ", "B")).toBeNull()
    expect(key(IBAN, "GmbH", "B")).toBeNull() // legal-form-only name
    expect(key(IBAN, "A", null)).toBeNull()
  })
})

describe("suggestLabelIds", () => {
  it("returns the rule for an exact tuple match", () => {
    const miete = cat("Miete")
    rule(miete, IBAN, "vermieter", "mieter")

    expect(
      suggestLabelIds(db, key(IBAN, "Vermieter GmbH", "Mieter AG")!)
    ).toEqual([miete])
  })

  it("requires every tuple component to match", () => {
    const miete = cat("Miete")
    rule(miete, IBAN, "vermieter", "mieter")

    expect(suggestLabelIds(db, key(IBAN, "Vermieter", "Other")!)).toEqual([])
    expect(suggestLabelIds(db, key(IBAN, "Other", "Mieter")!)).toEqual([])
    expect(
      suggestLabelIds(db, key("DE00999999990000000099", "Vermieter", "Mieter")!)
    ).toEqual([])
  })

  it("returns nothing without a rule match", () => {
    expect(suggestLabelIds(db, key(IBAN, "A", "B")!)).toEqual([])
    expect(
      suggestLabelIds(db, { ibanKey: "", payerKey: "a", payeeKey: "b" })
    ).toEqual([])
  })
})

describe("suggestForBatch", () => {
  it("maps suggestions per transaction and queries each tuple once", () => {
    const miete = cat("Miete")
    rule(miete, IBAN, "vermieter", "mieter")

    const result = suggestForBatch([
      { counterpartyIban: IBAN, payer: "Vermieter", payee: "Mieter" },
      {
        counterpartyIban: " de02 1203 0000 0000 2020 51 ",
        payer: "vermieter gmbh",
        payee: "Mieter",
      },
      { counterpartyIban: IBAN, payer: null, payee: "Mieter" },
      {
        counterpartyIban: "DE00UNMATCHED00000000",
        payer: "Vermieter",
        payee: "Mieter",
      },
    ])

    expect(result.get(0)).toEqual([miete])
    expect(result.get(1)).toEqual([miete])
    expect(result.get(2)).toEqual([])
    expect(result.get(3)).toEqual([])
  })
})

describe("learnRule", () => {
  it("inserts a rule with normalized tuple keys and display names", () => {
    const miete = cat("Miete")
    const id = learnRule(db, {
      counterpartyIban: " de02 1203 0000 0000 2020 51 ",
      payer: "ISSUER",
      payee: "Vermieter GmbH",
      labelId: miete,
    })

    expect(id).not.toBeNull()
    const row = db.select().from(labelRules).all()[0]
    expect(row.iban).toBe(IBAN)
    expect(row.payerKey).toBe("issuer")
    expect(row.payeeKey).toBe("vermieter")
    expect(row.payer).toBe("ISSUER")
    expect(row.payee).toBe("Vermieter GmbH")
    expect(row.labelId).toBe(miete)
  })

  it("upserts: re-assigning the same tuple replaces the label", () => {
    const miete = cat("Miete")
    const kaution = cat("Kaution")
    learnRule(db, {
      counterpartyIban: IBAN,
      payer: "ISSUER",
      payee: "Vermieter",
      labelId: miete,
    })
    learnRule(db, {
      counterpartyIban: IBAN,
      payer: "ISSUER",
      payee: "vermieter gmbh",
      labelId: kaution,
    })

    const rules = db.select().from(labelRules).all()
    // same tuple → replaced, newest wins
    expect(rules).toHaveLength(1)
    expect(rules[0].labelId).toBe(kaution)
    expect(rules[0].payee).toBe("vermieter gmbh")
  })

  it("keeps sibling tuples as separate rules", () => {
    const miete = cat("Miete")
    learnRule(db, {
      counterpartyIban: IBAN,
      payer: "ISSUER",
      payee: "EDEKA",
      labelId: miete,
    })
    learnRule(db, {
      counterpartyIban: IBAN,
      payer: "ISSUER",
      payee: "REWE",
      labelId: miete,
    })

    expect(db.select().from(labelRules).all()).toHaveLength(2)
  })

  it("rejects junk IBANs and empty payer/payee", () => {
    const miete = cat("Miete")
    expect(
      learnRule(db, {
        counterpartyIban: "IBAN123",
        payer: "A",
        payee: "B",
        labelId: miete,
      })
    ).toBeNull()
    expect(
      learnRule(db, {
        counterpartyIban: IBAN,
        payer: "   ",
        payee: "B",
        labelId: miete,
      })
    ).toBeNull()
    expect(
      learnRule(db, {
        counterpartyIban: IBAN,
        payer: "A",
        payee: null,
        labelId: miete,
      })
    ).toBeNull()
    expect(
      learnRule(db, {
        counterpartyIban: null,
        payer: "A",
        payee: "B",
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
