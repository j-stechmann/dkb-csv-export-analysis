import { describe, it, expect, beforeEach } from "vitest"
import { eq, sql } from "drizzle-orm"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import {
  accounts,
  importBatches,
  transactions,
} from "@/lib/db/schema"
import { computeDedupe } from "@/lib/db/dedupe"
import { runReconcileAndDedupeStage } from "@/lib/import/pipeline"
import type { ParsedTransactionRow } from "@/lib/csv/parser"

const ACC_IBAN = "DE02120300000000202051"
const ACC_NAME = "Girokonto"

function row(
  overrides: Partial<ParsedTransactionRow> = {}
): ParsedTransactionRow {
  return {
    bookingDate: "2026-02-03",
    valueDate: "2026-02-03",
    status: "Gebucht",
    payer: "",
    payee: "REWE",
    purpose: "Einkauf",
    type: "Ausgang",
    counterpartyIban: "DE02100100123456789001",
    amountCents: -100,
    creditorId: "",
    mandateRef: "",
    customerRef: "",
    ...overrides,
  }
}

let db: Db
let accountId: number

function seedDbRow(
  batchId: string,
  t: ParsedTransactionRow
): string {
  const first = computeDedupe(ACC_IBAN, accountId, batchId, [t], new Map())
  expect(first.duplicateCount).toBe(0)
  db.transaction((tx) => {
    for (const ins of first.toInsert) {
      tx.insert(transactions).values(ins).run()
    }
  })
  return first.toInsert[0].id
}

function startBatch(batchId: string): string {
  db.insert(importBatches)
    .values({
      id: batchId,
      fileName: `${batchId}.csv`,
      accountId,
      status: "importing",
      rowsTotal: 0,
    })
    .run()
  return batchId
}

beforeEach(() => {
  db = createTestDb()
  setTestDb(db)
  accountId = db
    .insert(accounts)
    .values({ iban: ACC_IBAN, name: ACC_NAME })
    .returning()
    .get().id
})

describe("import fuzzy reconciliation stages", () => {
  it("upgrade: booked incoming updates the DB pending row in place", () => {
    const pending = row({
      status: "Nicht gebucht",
      bookingDate: "2026-02-03",
    })
    const batch1 = startBatch("b1")
    const dbId = seedDbRow(batch1, pending)

    const batch2 = startBatch("b2")
    const booked = row({
      status: "Gebucht",
      bookingDate: "2026-02-04",
      purpose: "Einkauf REWE",
    })

    const res = runReconcileAndDedupeStage(ACC_IBAN, accountId, batch2, [booked])

    expect(res.updatedCount).toBe(1)
    expect(res.insertedCount).toBe(0)
    expect(res.duplicateCount).toBe(0)

    const updated = db
      .select()
      .from(transactions)
      .where(eq(transactions.id, dbId))
      .get()
    expect(updated).toBeDefined()
    expect(updated!.status).toBe("Gebucht")
    expect(updated!.bookingDate).toBe("2026-02-04")
    expect(updated!.purpose).toBe("Einkauf REWE")
    expect(updated!.batchId).toBe(batch2)
    expect(updated!.labelStatus).toBe("pending")
    expect(updated!.labelAttempts).toBe(0)
    // old pending hash must not linger as a duplicate slot
    const hashes = db
      .select({
        sourceHash: transactions.sourceHash,
        occurrenceIndex: transactions.occurrenceIndex,
      })
      .from(transactions)
      .all()
    expect(hashes).toHaveLength(1)

    const batch = db
      .select()
      .from(importBatches)
      .where(eq(importBatches.id, batch2))
      .get()
    expect(batch!.rowsUpdated).toBe(1)
    expect(batch!.rowsImported).toBe(0)
    expect(batch!.rowsDuplicate).toBe(0)
  })

  it("skip: pending incoming against booked DB row is not imported", () => {
    const batch1 = startBatch("b1")
    seedDbRow(batch1, row({ status: "Gebucht", bookingDate: "2026-02-03" }))

    const batch2 = startBatch("b2")
    const pending = row({
      status: "Nicht gebucht",
      bookingDate: "2026-02-03",
    })

    const res = runReconcileAndDedupeStage(ACC_IBAN, accountId, batch2, [pending])

    expect(res.skippedCount).toBe(1)
    expect(res.insertedCount).toBe(0)
    const all = db.select().from(transactions).all()
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe("Gebucht")
    expect(all[0].batchId).toBe(batch1)
  })

  it("refresh: pending incoming with moved bookingDate updates the DB row", () => {
    const batch1 = startBatch("b1")
    const dbId = seedDbRow(
      batch1,
      row({ status: "Nicht gebucht", bookingDate: "2026-02-01" })
    )

    const batch2 = startBatch("b2")
    const pending = row({
      status: "Nicht gebucht",
      bookingDate: "2026-02-02",
    })

    const res = runReconcileAndDedupeStage(ACC_IBAN, accountId, batch2, [pending])

    expect(res.updatedCount).toBe(1)
    const updated = db
      .select()
      .from(transactions)
      .where(eq(transactions.id, dbId))
      .get()
    expect(updated!.bookingDate).toBe("2026-02-02")
  })

  it("exact duplicate pending re-import stays a duplicate (matcher not double-processing)", () => {
    const batch1 = startBatch("b1")
    const dbId = seedDbRow(
      batch1,
      row({ status: "Nicht gebucht", bookingDate: "2026-02-03" })
    )

    const batch2 = startBatch("b2")
    const same = row({
      status: "Nicht gebucht",
      bookingDate: "2026-02-03",
    })

    const res = runReconcileAndDedupeStage(ACC_IBAN, accountId, batch2, [same])

    expect(res.duplicateCount).toBe(1)
    expect(res.updatedCount).toBe(0)
    expect(res.insertedCount).toBe(0)
    const all = db.select().from(transactions).all()
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(dbId)
  })

  it("self-heal: DB pending matching DB booked is deleted on next import", () => {
    const batch1 = startBatch("b1")
    seedDbRow(
      batch1,
      row({ status: "Nicht gebucht", bookingDate: "2026-02-03" })
    )
    seedDbRow(batch1, row({ status: "Gebucht", bookingDate: "2026-02-03" }))

    const batch2 = startBatch("b2")
    const res = runReconcileAndDedupeStage(ACC_IBAN, accountId, batch2, [])

    expect(res.deletedCount).toBe(1)
    const all = db.select().from(transactions).all()
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe("Gebucht")
  })

  it("mixed batch: booked upgrade + pending skip + fresh insert in one run", () => {
    const batch1 = startBatch("b1")
    seedDbRow(
      batch1,
      row({
        status: "Nicht gebucht",
        bookingDate: "2026-02-03",
        payee: "REWE",
      })
    )

    const batch2 = startBatch("b2")
    const res = runReconcileAndDedupeStage(ACC_IBAN, accountId, batch2, [
      row({ status: "Gebucht", bookingDate: "2026-02-03", payee: "REWE" }),
      row({
        status: "Nicht gebucht",
        bookingDate: "2026-02-03",
        payee: "REWE",
      }),
      row({
        status: "Gebucht",
        bookingDate: "2026-02-05",
        payee: "ALDI",
        counterpartyIban: "DE02100100123456789002",
      }),
    ])

    expect(res.updatedCount).toBe(1)
    // the pending copy is caught by the exact tier (old pending hash of the
    // upgraded row still occupied), so no fuzzy skip is needed
    expect(res.skippedCount).toBe(0)
    expect(res.insertedCount).toBe(1)
    // the pending copy of the upgraded REWE row must not insert a phantom
    expect(res.duplicateCount).toBe(1)

    const all = db.select().from(transactions).all()
    expect(all).toHaveLength(2)
    expect(all.filter((t) => t.status === "Gebucht")).toHaveLength(2)

    const batch = db
      .select()
      .from(importBatches)
      .where(eq(importBatches.id, batch2))
      .get()
    expect(batch!.rowsImported).toBe(1)
    expect(batch!.rowsDuplicate).toBe(1)
    expect(batch!.rowsUpdated).toBe(1)
  })

  it("invariant holds on a pure re-import of an already-reconciled file", () => {
    const batch1 = startBatch("b1")
    seedDbRow(
      batch1,
      row({ status: "Nicht gebucht", bookingDate: "2026-02-03" })
    )

    const batch2 = startBatch("b2")
    runReconcileAndDedupeStage(ACC_IBAN, accountId, batch2, [
      row({ status: "Gebucht", bookingDate: "2026-02-03" }),
    ])

    const batch3 = startBatch("b3")
    const res = runReconcileAndDedupeStage(ACC_IBAN, accountId, batch3, [
      row({ status: "Gebucht", bookingDate: "2026-02-03" }),
    ])
    expect(res.duplicateCount).toBe(1)
    expect(res.updatedCount).toBe(0)
    expect(res.insertedCount).toBe(0)
    const n =
      db
        .select({ c: sql<number>`count(*)` })
        .from(transactions)
        .get()?.c ?? 0
    expect(n).toBe(1)
  })
})