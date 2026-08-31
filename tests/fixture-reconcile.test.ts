import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql, eq } from "drizzle-orm"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import { parseDkbCsv } from "@/lib/csv/parser"
import { runReconcileAndDedupeStage } from "@/lib/import/pipeline"
import { computeDedupe } from "@/lib/db/dedupe"
import { transactions, accounts, importBatches } from "@/lib/db/schema"

interface ResolveManifest {
  account: { iban: string; name: string }
  layout: {
    bookedPendingShopVersions: number
    purposeChangedCount: number
    purposeUnchangedCount: number
    upgradeCount: number
  }
  rowCount: number
  expected: {
    upgrades: number
    unchangedDuplicates: number
    newBookedCount: number
    duplicatePendingCopies: number
    insertedCount: number
    updatedCount: number
    skippedCount: number
    duplicateCount: number
    totalTransactionsAfter: number
  }
}

const fixtureDir = join(__dirname, "fixtures")
const csv1 = readFileSync(join(fixtureDir, "fixture.csv"), "utf8")
const csv2 = readFileSync(
  join(fixtureDir, "fixture-pending-resolved.csv"),
  "utf8"
)
const manifest1 = JSON.parse(
  readFileSync(join(fixtureDir, "fixture-manifest.json"), "utf8")
) as { rowCount: number; account: { iban: string } }
const manifest2: ResolveManifest = JSON.parse(
  readFileSync(
    join(fixtureDir, "fixture-pending-resolved-manifest.json"),
    "utf8"
  )
)

let db: Db
let batchId2: string
let stage2Result: ReturnType<typeof runReconcileAndDedupeStage>

beforeAll(() => {
  db = createTestDb()
  setTestDb(db)

  // ── stage 1: plain full import of fixture.csv (batch-1) ─────────────
  const parsed1 = parseDkbCsv(csv1)
  expect(parsed1.rows).toHaveLength(manifest1.rowCount)

  const account = db
    .insert(accounts)
    .values({ iban: parsed1.accountIban, name: parsed1.accountName })
    .returning()
    .get()

  const batch1 = db
    .insert(importBatches)
    .values({
      id: "reconcile-batch-1",
      fileName: "fixture.csv",
      accountId: account.id,
      status: "importing",
      snapshotDate: parsed1.snapshotDate,
      snapshotAmountCents: parsed1.snapshotAmountCents,
      rowsTotal: parsed1.rows.length,
    })
    .returning()
    .get()

  const first = computeDedupe(
    parsed1.accountIban,
    account.id,
    batch1.id,
    parsed1.rows,
    new Map()
  )
  expect(first.duplicateCount).toBe(0)
  expect(first.toInsert).toHaveLength(parsed1.rows.length)

  db.transaction((tx) => {
    for (const row of first.toInsert) {
      tx.insert(transactions).values(row).run()
    }
  })

  // ── stage 2: reconcile/dedupe stage with fixture-pending-resolved ──
  const parsed2 = parseDkbCsv(csv2)
  expect(parsed2.accountIban).toBe(manifest2.account.iban)
  expect(parsed2.rows).toHaveLength(manifest2.rowCount)

  const batch2 = db
    .insert(importBatches)
    .values({
      id: "reconcile-batch-2",
      fileName: "fixture-pending-resolved.csv",
      accountId: account.id,
      status: "importing",
      snapshotDate: parsed2.snapshotDate,
      snapshotAmountCents: parsed2.snapshotAmountCents,
      rowsTotal: parsed2.rows.length,
    })
    .returning()
    .get()
  batchId2 = batch2.id

  stage2Result = runReconcileAndDedupeStage(
    parsed2.accountIban,
    account.id,
    batchId2,
    parsed2.rows
  )
})

describe("fixture two-stage reconcile end-to-end", () => {
  it("stage 2 counts match the manifest (fuzzy + exact tiers)", () => {
    const e = manifest2.expected
    expect(stage2Result.updatedCount).toBe(e.updatedCount)
    expect(stage2Result.insertedCount).toBe(e.insertedCount)
    expect(stage2Result.skippedCount).toBe(e.skippedCount)
    expect(stage2Result.duplicateCount).toBe(e.duplicateCount)
    expect(stage2Result.deletedCount).toBe(0)
  })

  it("stage and pipeline invariants hold", () => {
    const e = manifest2.expected
    // per-row classification covers the whole file
    expect(
      e.insertedCount + e.updatedCount + e.skippedCount + e.duplicateCount
    ).toBe(manifest2.rowCount)
    // pipeline-level invariant: imported + duplicates + updated === total
    expect(
      stage2Result.imported +
        stage2Result.duplicateCount +
        stage2Result.updatedCount
    ).toBe(manifest2.rowCount)
  })

  it("DB has no phantoms after the reconcile import", () => {
    const total =
      db
        .select({ c: sql<number>`count(*)` })
        .from(transactions)
        .all()[0]?.c ?? 0
    expect(total).toBe(manifest2.expected.totalTransactionsAfter)
    expect(total).toBe(manifest1.rowCount + manifest2.expected.newBookedCount)
  })

  it("all 24 ex-pending rows are now booked on day 30 from batch 2", () => {
    const pendingShop = db
      .select()
      .from(transactions)
      .where(eq(transactions.payee, "Pending Shop"))
      .all()
    expect(pendingShop).toHaveLength(manifest2.expected.upgrades)
    for (const t of pendingShop) {
      expect(t.status).toBe("Gebucht")
      expect(t.batchId).toBe(batchId2)
      expect(t.labelStatus).toBe("pending")
      // day 28 → 30 (+2 days); February clamps to month end (29.02.24 /
      // 28.02.25), always inside the ±7 match window
      const day = Number.parseInt(t.bookingDate.slice(8, 10), 10)
      if (t.bookingDate.slice(5, 7) === "02") {
        expect(day === 28 || day === 29).toBe(true)
      } else {
        expect(day).toBe(30)
      }
    }
    // exactly one upgrade carried a changed purpose
    const changed = pendingShop.filter(
      (t) => t.purpose !== "Noch nicht gebucht"
    )
    expect(changed).toHaveLength(manifest2.layout.purposeChangedCount)
    expect(changed[0].purpose).toBe("Pending Shop Bestellung 2025-06")
  })

  it("no Nicht gebucht rows remain in the DB for Pending Shop rows", () => {
    const pending = db
      .select()
      .from(transactions)
      .where(
        sql`${transactions.payee} = 'Pending Shop' AND ${transactions.status} = 'Nicht gebucht'`
      )
      .all()
    expect(pending).toHaveLength(0)
  })

  it("new booked rows are the only batch-2 inserts", () => {
    // batchId2 covers exactly: the 5 inserts + the 24 in-place updated
    // ex-pending rows (updates re-point batchId); nothing else
    const withBatch2 = db
      .select()
      .from(transactions)
      .where(eq(transactions.batchId, batchId2))
      .all()
    expect(withBatch2).toHaveLength(
      manifest2.expected.insertedCount + manifest2.expected.updatedCount
    )
    const inserted = withBatch2.filter(
      (t) => t.payee === "Resolved Shop" || t.payer === "Resolved Shop"
    )
    expect(inserted).toHaveLength(manifest2.expected.newBookedCount)
    for (const t of inserted) {
      // Ausgang → payee is the shop, Eingang → payer is the shop
      expect(t.payee === "Resolved Shop" || t.payer === "Resolved Shop").toBe(
        true
      )
      expect(t.status).toBe("Gebucht")
    }
    const updated = withBatch2.filter((t) => t.payee === "Pending Shop")
    expect(updated).toHaveLength(manifest2.expected.updatedCount)
  })

  it("batch-2 counters recorded correctly", () => {
    const batch = db
      .select()
      .from(importBatches)
      .where(eq(importBatches.id, batchId2))
      .get()
    expect(batch).toBeDefined()
    expect(batch!.rowsImported).toBe(manifest2.expected.insertedCount)
    expect(batch!.rowsDuplicate).toBe(manifest2.expected.duplicateCount)
    expect(batch!.rowsUpdated).toBe(manifest2.expected.updatedCount)
  })
})
