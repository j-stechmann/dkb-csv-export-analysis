import { describe, it, expect, beforeEach } from "vitest"
import { eq } from "drizzle-orm"
import type { Db } from "@/lib/db"
import { categories, labelRules } from "@/lib/db/schema"
import {
  learnRule,
  resolveLabelNames,
  suggestForBatch,
  suggestLabelIds,
} from "@/lib/labels/matching"
import { resetConfigCache } from "@/lib/config"
import { setupTestDb } from "./helpers"

const IBAN = "DE02120300000000202051"
const PAYER = "Max Mustermann"
const PAYEE = "Vermieter GmbH"

let db: Db
let userId: number

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
      userId,
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
  overrides: Partial<{
    payer: string
    payee: string
    counterpartyIban: string
    createdAt: string
    updatedAt: string
  }> = {}
): number {
  return db
    .insert(labelRules)
    .values({
      userId,
      labelId,
      payer: PAYER,
      payee: PAYEE,
      counterpartyIban: IBAN,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    })
    .returning()
    .get().id
}

beforeEach(() => {
  ;({ db, userId } = setupTestDb())
  resetConfigCache()
})

describe("suggestLabelIds", () => {
  it("returns rules for an exact triple match", () => {
    const miete = cat("Miete")
    rule(miete)

    expect(
      suggestLabelIds(db, userId, {
        payer: PAYER,
        payee: PAYEE,
        counterpartyIban: IBAN,
      })
    ).toEqual([miete])
  })

  it("returns nothing when any component differs", () => {
    const miete = cat("Miete")
    rule(miete)

    expect(
      suggestLabelIds(db, userId, {
        payer: "Other Payer",
        payee: PAYEE,
        counterpartyIban: IBAN,
      })
    ).toEqual([])
    expect(
      suggestLabelIds(db, userId, {
        payer: PAYER,
        payee: "Other Payee",
        counterpartyIban: IBAN,
      })
    ).toEqual([])
    expect(
      suggestLabelIds(db, userId, {
        payer: PAYER,
        payee: PAYEE,
        counterpartyIban: "DE00UNMATCHED00000000",
      })
    ).toEqual([])
  })

  it("returns nothing without a usable rule key", () => {
    expect(
      suggestLabelIds(db, userId, {
        payer: null,
        payee: PAYEE,
        counterpartyIban: IBAN,
      })
    ).toEqual([])
    expect(
      suggestLabelIds(db, userId, {
        payer: PAYER,
        payee: "",
        counterpartyIban: IBAN,
      })
    ).toEqual([])
    expect(
      suggestLabelIds(db, userId, {
        payer: PAYER,
        payee: PAYEE,
        counterpartyIban: "   ",
      })
    ).toEqual([])
  })

  it("matches only when the stored values are byte-identical", () => {
    const miete = cat("Miete")
    // rule stores a space-separated IBAN rendering — a compacted IBAN
    // must NOT match it (no normalization anywhere)
    rule(miete, { counterpartyIban: "DE02 1203 0000 0000 2020 51" })

    expect(
      suggestLabelIds(db, userId, {
        payer: PAYER,
        payee: PAYEE,
        counterpartyIban: "DE02120300000000202051",
      })
    ).toEqual([])
    expect(
      suggestLabelIds(db, userId, {
        payer: PAYER,
        payee: PAYEE,
        counterpartyIban: "DE02 1203 0000 0000 2020 51",
      })
    ).toEqual([miete])
  })

  it("returns the single rule for the triple (unique index)", () => {
    const a = cat("A")
    rule(a)

    expect(
      suggestLabelIds(db, userId, {
        payer: PAYER,
        payee: PAYEE,
        counterpartyIban: IBAN,
      })
    ).toEqual([a])
  })
})

describe("suggestForBatch", () => {
  it("maps suggestions per transaction and queries each triple once", () => {
    const miete = cat("Miete")
    rule(miete)

    const result = suggestForBatch(userId, [
      { payer: PAYER, payee: PAYEE, counterpartyIban: IBAN },
      { payer: PAYER, payee: PAYEE, counterpartyIban: IBAN },
      { payer: null, payee: PAYEE, counterpartyIban: IBAN },
      { payer: PAYER, payee: PAYEE, counterpartyIban: "DE00UNMATCHED00000000" },
    ])

    expect(result.get(0)).toEqual([miete])
    expect(result.get(1)).toEqual([miete])
    expect(result.get(2)).toEqual([])
    expect(result.get(3)).toEqual([])
  })
})

describe("learnRule", () => {
  it("inserts a rule with the transaction's verbatim values", () => {
    const miete = cat("Miete")
    const id = learnRule(db, {
      userId,
      payer: " Max  Mustermann ",
      payee: "Vermieter GmbH",
      counterpartyIban: " de02 1203 0000 0000 2020 51 ",
      labelId: miete,
    })

    expect(id).not.toBeNull()
    const row = db.select().from(labelRules).all()[0]
    expect(row.payer).toBe(" Max  Mustermann ")
    expect(row.payee).toBe("Vermieter GmbH")
    expect(row.counterpartyIban).toBe(" de02 1203 0000 0000 2020 51 ")
    expect(row.labelId).toBe(miete)
  })

  it("upserts: re-learning the same triple replaces the label", () => {
    const miete = cat("Miete")
    const kaution = cat("Kaution")
    learnRule(db, {
      userId,
      payer: PAYER,
      payee: PAYEE,
      counterpartyIban: IBAN,
      labelId: miete,
    })
    learnRule(db, {
      userId,
      payer: PAYER,
      payee: PAYEE,
      counterpartyIban: IBAN,
      labelId: kaution,
    })

    const rules = db.select().from(labelRules).all()
    expect(rules).toHaveLength(1)
    expect(rules[0].labelId).toBe(kaution)
  })

  it("keeps rules with differing components as separate rows", () => {
    const miete = cat("Miete")
    learnRule(db, {
      userId,
      payer: PAYER,
      payee: PAYEE,
      counterpartyIban: IBAN,
      labelId: miete,
    })
    learnRule(db, {
      userId,
      payer: PAYER,
      payee: "Other Payee",
      counterpartyIban: IBAN,
      labelId: miete,
    })

    expect(db.select().from(labelRules).all()).toHaveLength(2)
  })

  it("rejects null or empty components", () => {
    const miete = cat("Miete")
    expect(
      learnRule(db, {
        userId,
        payer: null,
        payee: PAYEE,
        counterpartyIban: IBAN,
        labelId: miete,
      })
    ).toBeNull()
    expect(
      learnRule(db, {
        userId,
        payer: PAYER,
        payee: "",
        counterpartyIban: IBAN,
        labelId: miete,
      })
    ).toBeNull()
    expect(
      learnRule(db, {
        userId,
        payer: PAYER,
        payee: PAYEE,
        counterpartyIban: null,
        labelId: miete,
      })
    ).toBeNull()
    expect(
      learnRule(db, {
        userId,
        payer: "   ",
        payee: PAYEE,
        counterpartyIban: IBAN,
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
