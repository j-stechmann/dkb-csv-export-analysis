import { describe, it, expect, beforeEach } from "vitest"
import { eq } from "drizzle-orm"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import {
  accounts,
  categories,
  importBatches,
  labelRules,
  transactions,
} from "@/lib/db/schema"
import {
  applyLabelResults,
  completeDrainedBatches,
  markRowsFailed,
  normalizeCategoryKey,
  pruneOrphanCategories,
  resetTransactionsForLabelDeletion,
  resolveAndUseCategory,
} from "@/lib/labeller/service"
import { learnRule } from "@/lib/labels/matching"

const IBAN = "DE02120300000000202051"

let db: Db
let accountId: number
let batchCounter = 0

function seedBatch(status = "labeling"): string {
  batchCounter++
  const id = `b${batchCounter}`
  db.insert(importBatches)
    .values({ id, fileName: `${id}.csv`, accountId, status })
    .run()
  return id
}

function seedTx(
  batchId: string,
  overrides: Partial<{
    labelStatus: string
    labelAttempts: number
    categoryId: number | null
    counterpartyIban: string | null
  }> = {}
): string {
  const id = `tx-${crypto.randomUUID()}`
  db.insert(transactions)
    .values({
      id,
      accountId,
      batchId,
      bookingDate: "2026-02-03",
      status: "Gebucht",
      payee: "Vermieter GmbH",
      type: "Ausgang",
      counterpartyIban: IBAN,
      amountCents: -100,
      sourceHash: `hash-${id}`,
      labelStatus: "pending",
      labelAttempts: 0,
      ...overrides,
    })
    .run()
  return id
}

function getTx(id: string) {
  return db.select().from(transactions).where(eq(transactions.id, id)).get()
}

function getBatch(id: string) {
  return db.select().from(importBatches).where(eq(importBatches.id, id)).get()
}

beforeEach(() => {
  db = createTestDb()
  setTestDb(db)
  accountId = db
    .insert(accounts)
    .values({ iban: IBAN, name: "Girokonto" })
    .returning()
    .get().id
})

describe("resolveAndUseCategory", () => {
  it("creates a category with origin llm and increments usage", () => {
    db.transaction((tx) => {
      const id1 = resolveAndUseCategory(tx, "Lebensmittel")
      expect(id1).not.toBeNull()
      const id2 = resolveAndUseCategory(tx, "lebensmittel ")
      expect(id2).toBe(id1)
    })

    const cat = db.select().from(categories).all()[0]
    expect(cat.origin).toBe("llm")
    expect(cat.usageCount).toBe(2)
    expect(cat.nameKey).toBe("lebensmittel")
  })
})

describe("applyLabelResults increments usageCount", () => {
  it("counts applied labels per category", () => {
    const batchId = seedBatch()
    const a = seedTx(batchId)
    const b = seedTx(batchId)

    const claimed = new Map([
      [a, 1],
      [b, 1],
    ])
    // claim first
    const rows = db.select({ id: transactions.id }).from(transactions).all()
    void rows
    // simulate claim attempts (claimLabelRows covers this in worker tests)
    db.transaction((tx) => {
      for (const id of [a, b]) {
        tx.update(transactions)
          .set({ labelAttempts: 1 })
          .where(eq(transactions.id, id))
          .run()
      }
    })

    applyLabelResults(
      [
        { id: a, label: "Miete" },
        { id: b, label: "Miete" },
      ],
      claimed
    )

    const cat = db.select().from(categories).all()[0]
    expect(cat.name).toBe("Miete")
    expect(cat.usageCount).toBe(2)
  })
})

describe("resetTransactionsForLabelDeletion", () => {
  it("resets transactions to pending and re-points completed batches", () => {
    const batchId = seedBatch("completed")
    const a = seedTx(batchId, { labelStatus: "labeled" })

    const catId = db
      .insert(categories)
      .values({ name: "Alt", nameKey: "alt", language: "de" })
      .returning()
      .get().id
    db.update(transactions)
      .set({ categoryId: catId })
      .where(eq(transactions.id, a))
      .run()

    const affected = resetTransactionsForLabelDeletion(catId)

    expect(affected).toEqual([a])
    const row = getTx(a)!
    expect(row.categoryId).toBeNull()
    expect(row.labelStatus).toBe("pending")
    expect(row.labelAttempts).toBe(0)
  })

  it("re-points only completed batches to labeling", () => {
    const completed = seedBatch("completed")
    const failed = seedBatch("failed")
    const a = seedTx(completed)
    const b = seedTx(failed)

    const catId = db
      .insert(categories)
      .values({ name: "Alt", nameKey: "alt", language: "de" })
      .returning()
      .get().id
    db.update(transactions)
      .set({ categoryId: catId })
      .where(eq(transactions.id, a))
      .run()
    db.update(transactions)
      .set({ categoryId: catId })
      .where(eq(transactions.id, b))
      .run()

    resetTransactionsForLabelDeletion(catId)

    expect(getBatch(completed)!.status).toBe("labeling")
    expect(getBatch(failed)!.status).toBe("failed")
  })
})

describe("delete cascade", () => {
  it("deleting a category cascades its rules", () => {
    const catId = db
      .insert(categories)
      .values({ name: "X", nameKey: "x", language: "de" })
      .returning()
      .get().id
    db.insert(labelRules)
      .values({
        labelId: catId,
        iban: IBAN,
        nameKey: "vermieter",
        name: "Vermieter",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run()

    db.delete(categories).where(eq(categories.id, catId)).run()

    expect(db.select().from(labelRules).all()).toHaveLength(0)
  })
})

describe("pruneOrphanCategories", () => {
  it("prunes unused llm categories but keeps manual ones and rule-referenced ones", () => {
    const unusedLlm = db
      .insert(categories)
      .values({
        name: "UnusedLlm",
        nameKey: "unusedllm",
        language: "de",
        origin: "llm",
      })
      .returning()
      .get().id
    const manual = db
      .insert(categories)
      .values({
        name: "Manual",
        nameKey: "manual",
        language: "de",
        origin: "manual",
      })
      .returning()
      .get().id
    const withRule = db
      .insert(categories)
      .values({
        name: "WithRule",
        nameKey: "withrule",
        language: "de",
        origin: "llm",
      })
      .returning()
      .get().id
    db.insert(labelRules)
      .values({
        labelId: withRule,
        iban: IBAN,
        nameKey: "x",
        name: "X",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run()

    expect(pruneOrphanCategories()).toBe(1)

    const remaining = db.select({ id: categories.id }).from(categories).all()
    const ids = new Set(remaining.map((r) => r.id))
    expect(ids.has(unusedLlm)).toBe(false)
    expect(ids.has(manual)).toBe(true)
    expect(ids.has(withRule)).toBe(true)
  })
})

describe("learnRule inside transaction (manual assign path)", () => {
  it("learns a rule for the counterparty of a transaction", () => {
    const batchId = seedBatch()
    const id = seedTx(batchId)
    const catId = db
      .insert(categories)
      .values({ name: "Miete", nameKey: "miete", language: "de" })
      .returning()
      .get().id

    db.transaction((tx) => {
      tx.update(transactions)
        .set({ categoryId: catId, labelStatus: "labeled", labelAttempts: 0 })
        .where(eq(transactions.id, id))
        .run()
      const learned = learnRule(tx, {
        counterpartyIban: IBAN,
        counterpartyName: "Vermieter GmbH",
        labelId: catId,
      })
      expect(learned).not.toBeNull()
    })

    const rules = db.select().from(labelRules).all()
    expect(rules).toHaveLength(1)
    expect(rules[0].labelId).toBe(catId)
    expect(rules[0].iban).toBe(IBAN)
  })
})

describe("markRowsFailed preserves manual labels", () => {
  it("skips rows reset to attempts 0 (manual assignment wins)", () => {
    const batchId = seedBatch()
    const id = seedTx(batchId)

    // claim (attempts → 1), then manual assign resets attempts to 0
    db.transaction((tx) => {
      tx.update(transactions)
        .set({ labelAttempts: 1 })
        .where(eq(transactions.id, id))
        .run()
    })
    const manualCat = db
      .insert(categories)
      .values({
        name: "Manuell",
        nameKey: "manuell",
        language: "de",
        origin: "manual",
      })
      .returning()
      .get().id
    db.transaction((tx) => {
      tx.update(transactions)
        .set({
          categoryId: manualCat,
          labelStatus: "labeled",
          labelAttempts: 0,
        })
        .where(eq(transactions.id, id))
        .run()
    })

    markRowsFailed([id], new Map([[id, 1]]))

    const row = getTx(id)!
    expect(row.labelStatus).toBe("labeled")
    expect(row.categoryId).toBe(manualCat)
  })
})

describe("normalizeCategoryKey", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeCategoryKey("  Lebensmittel   Einkauf ")).toBe(
      "lebensmittel einkauf"
    )
  })
})

describe("completeDrainedBatches", () => {
  it("completes a labeling batch with no claimable rows and prunes", () => {
    seedBatch()
    expect(completeDrainedBatches(5)).toBe(1)
  })
})
