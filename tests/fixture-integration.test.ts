import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import {
  createTestDb,
  setTestDb,
  type Db,
} from "@/lib/db"
import { parseDkbCsv } from "@/lib/csv/parser"
import { computeDedupe } from "@/lib/db/dedupe"
import { computeAnalytics } from "@/lib/analytics/engine"
import { parseFilters } from "@/lib/analytics/queries"
import { transactions, accounts, importBatches, categories } from "@/lib/db/schema"
import { eq } from "drizzle-orm"

interface Manifest {
  account: { iban: string; name: string }
  snapshot: { date: string; amountCents: number }
  rowCount: number
  pendingCount: number
  zeroAmountCount: number
  expected: {
    transactionCount: number
    currentBalanceCents: number
    avgMonthlyIncomeCents: number
    avgMonthlyExpensesCents: number
    savingsRate: number
    monthsCounted: number
    monthlyCashflow: Array<{
      month: string
      incomeCents: number
      expensesCents: number
    }>
    topCategories: Array<{ name: string; totalCents: number }>
  }
}

const fixtureDir = join(__dirname, "fixtures")
const csv = readFileSync(join(fixtureDir, "fixture.csv"), "utf8")
const manifest: Manifest = JSON.parse(
  readFileSync(join(fixtureDir, "fixture-manifest.json"), "utf8")
)

let db: Db

/**
 * Import the fixture through the REAL pipeline pieces (parser → dedupe →
 * DB insert) against an in-memory SQLite, without the labeller.
 */
beforeAll(() => {
  db = createTestDb()
  setTestDb(db)

  const parsed = parseDkbCsv(csv)

  const account = db
    .insert(accounts)
    .values({ iban: parsed.accountIban, name: parsed.accountName })
    .returning()
    .get()

  const batch = db
    .insert(importBatches)
    .values({
      id: "fixture-batch",
      fileName: "fixture.csv",
      accountId: account.id,
      status: "importing",
      snapshotDate: parsed.snapshotDate,
      snapshotAmountCents: parsed.snapshotAmountCents,
      rowsTotal: parsed.rows.length,
    })
    .returning()
    .get()

  const dedupe = computeDedupe(
    parsed.accountIban,
    account.id,
    batch.id,
    parsed.rows,
    new Map()
  )
  expect(dedupe.duplicateCount).toBe(0)
  expect(dedupe.toInsert.length).toBe(parsed.rows.length)

  db.transaction((tx) => {
    for (const row of dedupe.toInsert) {
      tx.insert(transactions).values(row).run()
    }
  })

  // post-insert invariant: imported + duplicates === parsed rows
  const importedCount = db
    .select({ count: sql<number>`count(*)` })
    .from(transactions)
    .get()?.count ?? 0
  expect(importedCount).toBe(parsed.rows.length)

  // simulate the labeller: one category per counterparty (the fixture
  // manifest's topCategories are keyed on counterparty for this reason)
  const all = db.select().from(transactions).all()
  const catIdByCounterparty = new Map<string, number>()
  for (const t of all) {
    const label =
      t.type === "Ausgang" ? (t.payee ?? "") : (t.payer ?? "")
    if (!label || t.categoryId !== null) continue
    let catId = catIdByCounterparty.get(label)
    if (!catId) {
      const inserted = db
        .insert(categories)
        .values({ name: label, nameKey: label.toLowerCase(), language: "de" })
        .onConflictDoNothing()
        .returning()
        .get()
      const cat =
        inserted ??
        db
          .select()
          .from(categories)
          .where(eq(categories.nameKey, label.toLowerCase()))
          .get()
      catId = cat.id
      catIdByCounterparty.set(label, catId)
    }
    db.update(transactions)
      .set({ categoryId: catId, labelStatus: "labeled" })
      .where(eq(transactions.id, t.id))
      .run()
  }
})

describe("fixture end-to-end correctness", () => {
  it("parses all rows, account and snapshot", () => {
    const parsed = parseDkbCsv(csv)
    expect(parsed.accountIban).toBe(manifest.account.iban)
    expect(parsed.snapshotDate).toBe(manifest.snapshot.date)
    expect(parsed.snapshotAmountCents).toBe(manifest.snapshot.amountCents)
    expect(parsed.rows).toHaveLength(manifest.rowCount)
  })

  it("stores every row including pending and zero-amount", () => {
    const all = db.select().from(transactions).all()
    expect(all).toHaveLength(manifest.rowCount)
    const pending = all.filter((r) => r.status === "Nicht gebucht")
    expect(pending).toHaveLength(manifest.pendingCount)
    const zero = all.filter((r) => r.amountCents === 0)
    expect(zero).toHaveLength(manifest.zeroAmountCount)
  })

  it("preserves identical same-day transactions (coffee pair × 24 months)", () => {
    const coffees = db
      .select()
      .from(transactions)
      .where(eq(transactions.purpose, "Kaffee"))
      .all()
    expect(coffees).toHaveLength(48) // 2 per month × 24
    // each month contributes one occurrence 0 and one occurrence 1
    const counts = { 0: 0, 1: 0 } as Record<string, number>
    for (const c of coffees) {
      counts[String(c.occurrenceIndex)] =
        (counts[String(c.occurrenceIndex)] ?? 0) + 1
    }
    expect(counts["0"]).toBe(24)
    expect(counts["1"]).toBe(24)
  })

  it("computes current balance to the cent (latest snapshot + subsequent)", () => {
    const filters = parseFilters(new URLSearchParams())
    const result = computeAnalytics(filters, "2026-08-28")
    expect(result.kpis.currentBalanceCents).toBe(
      manifest.expected.currentBalanceCents
    )
    expect(result.kpis.balanceWithoutSnapshot).toBe(false)
  })

  it("matches hand-computed KPIs exactly", () => {
    const filters = parseFilters(new URLSearchParams())
    const result = computeAnalytics(filters, "2026-08-28")
    expect(result.kpis.transactionCount).toBe(
      manifest.expected.transactionCount
    )
    expect(result.kpis.avgMonthlyIncomeCents).toBe(
      manifest.expected.avgMonthlyIncomeCents
    )
    expect(result.kpis.avgMonthlyExpensesCents).toBe(
      manifest.expected.avgMonthlyExpensesCents
    )
    expect(result.kpis.savingsRate).toBeCloseTo(
      manifest.expected.savingsRate,
      10
    )
    expect(result.kpis.monthsCounted).toBe(manifest.expected.monthsCounted)
  })

  it("matches every month's income/expenses to the cent", () => {
    const filters = parseFilters(new URLSearchParams())
    const result = computeAnalytics(filters, "2026-08-28")
    expect(result.monthlyCashflow).toHaveLength(
      manifest.expected.monthlyCashflow.length
    )
    for (const expected of manifest.expected.monthlyCashflow) {
      const actual = result.monthlyCashflow.find(
        (m) => m.month === expected.month
      )
      expect(actual, `month ${expected.month}`).toBeDefined()
      expect(actual!.incomeCents).toBe(expected.incomeCents)
      expect(actual!.expensesCents).toBe(expected.expensesCents)
      expect(actual!.netCents).toBe(
        expected.incomeCents - expected.expensesCents
      )
    }
  })

  it("back-calculates the balance timeline from the snapshot anchor", () => {
    const filters = parseFilters(new URLSearchParams())
    const result = computeAnalytics(filters, "2026-08-28")
    const t = result.balanceTimeline

    // fixture: bookings start 2024-01-01, snapshot 2024-01-05 = 5.000,00 €
    // bookings ≤ snapshot: 01-01 +3500€, 01-03 −1200€, 01-05 −67,53€
    // → backward: 01-01 = 5000 + 1200 + 67,53 = 6267,53 €
    //             01-03 = 5000 + 67,53        = 5067,53 €
    // (01-05 IS the anchor point = 5000,00 €)
    expect(t.length).toBeGreaterThan(manifest.expected.monthlyCashflow.length)
    expect(t[0]).toEqual({ date: "2024-01-01", balanceCents: 626753 })
    expect(t[1]).toEqual({ date: "2024-01-03", balanceCents: 506753 })
    expect(t[2]).toEqual({ date: "2024-01-05", balanceCents: 500000 })

    // strictly ascending dates
    for (let i = 1; i < t.length; i++) {
      expect(t[i].date > t[i - 1].date, `${t[i].date} after ${t[i - 1].date}`).toBe(true)
    }

    // last point equals the current balance KPI
    expect(t[t.length - 1].balanceCents).toBe(
      manifest.expected.currentBalanceCents
    )
  })

  it("top categories match hand-computed totals", () => {
    const filters = parseFilters(new URLSearchParams())
    const result = computeAnalytics(filters, "2026-08-28")
    const actualByName = new Map(
      result.topCategories.map((c) => [c.name, c.totalCents])
    )
    for (const expected of manifest.expected.topCategories) {
      expect(actualByName.get(expected.name)).toBe(expected.totalCents)
    }
    // shares sum to ≤ 1 and top-1 is Miete (1.200,00 € / month dominates)
    expect(result.topCategories[0].name).toBe("Vermieter GmbH")
  })

  it("excludes pending rows from analytics by default but includes via status=all", () => {
    const bookedOnly = computeAnalytics(
      parseFilters(new URLSearchParams()),
      "2026-08-28"
    )
    expect(bookedOnly.kpis.transactionCount).toBe(
      manifest.expected.transactionCount
    )
    const withPending = computeAnalytics(
      parseFilters(new URLSearchParams("status=all")),
      "2026-08-28"
    )
    expect(withPending.kpis.transactionCount).toBe(manifest.rowCount)
  })

  it("re-import of the same fixture inserts nothing (full-file dedupe)", () => {
    const account = db
      .select()
      .from(accounts)
      .all()
      .find((a) => a.iban === manifest.account.iban)!

    const existingRows = db
      .select({
        sourceHash: transactions.sourceHash,
        occurrenceIndex: transactions.occurrenceIndex,
      })
      .from(transactions)
      .where(eq(transactions.accountId, account.id))
      .all()
    const existingByHash = new Map<string, Set<number>>()
    for (const r of existingRows) {
      let set = existingByHash.get(r.sourceHash)
      if (!set) {
        set = new Set()
        existingByHash.set(r.sourceHash, set)
      }
      set.add(r.occurrenceIndex)
    }

    const parsed = parseDkbCsv(csv)
    const second = computeDedupe(
      parsed.accountIban,
      account.id,
      "fixture-batch-2",
      parsed.rows,
      existingByHash
    )
    expect(second.toInsert).toHaveLength(0)
    expect(second.duplicateCount).toBe(parsed.rows.length)
  })
})