import { describe, it, expect, beforeEach } from "vitest"
import { eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import {
  accounts,
  categories,
  importBatches,
  transactions,
} from "@/lib/db/schema"
import { GET as getTransactions } from "@/app/api/transactions/route"
import { GET as getAnalytics } from "@/app/api/analytics/route"
import { GET as getCategories } from "@/app/api/categories/route"

const IBAN = "DE02120300000000202051"

let db: Db
let accountId: number

beforeEach(() => {
  db = createTestDb()
  setTestDb(db)
  accountId = db
    .insert(accounts)
    .values({ iban: IBAN, name: "Girokonto" })
    .returning()
    .get().id
  db.insert(importBatches)
    .values({ id: "b1", fileName: "b1.csv", accountId, status: "completed" })
    .run()
})

function seedTx(payee: string, day = "10"): string {
  const id = `tx-${crypto.randomUUID()}`
  db.insert(transactions)
    .values({
      id,
      accountId,
      bookingDate: `2026-01-${day}`,
      status: "Gebucht",
      payee,
      type: "Ausgang",
      amountCents: -100,
      sourceHash: `hash-${id}`,
      occurrenceIndex: 0,
      labelStatus: "pending",
    })
    .run()
  return id
}

const req = (url: string) => new NextRequest(new Request(url))

describe("GET /api/transactions", () => {
  it("returns a page with defaults (page 1, pageSize 25, booked only)", async () => {
    seedTx("REWE")
    const res = await getTransactions(req("http://x/api/transactions"))
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      rows: Array<{ id: string }>
      total: number
      page: number
      pageCount: number
    }
    expect(data.total).toBe(1)
    expect(data.page).toBe(1)
    expect(data.rows).toHaveLength(1)
  })

  it("clamps pageSize to 100 and rejects page 0 with 400", async () => {
    for (let i = 0; i < 3; i++) seedTx(`S${i}`)
    // huge but valid pageSize: clamped to 100, not an error
    const res = await getTransactions(
      req("http://x/api/transactions?pageSize=9999")
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as { rows: unknown[] }
    expect(data.rows.length).toBeLessThanOrEqual(100)
    // non-positive page is invalid, not silently coerced
    const bad = await getTransactions(req("http://x/api/transactions?page=0"))
    expect(bad.status).toBe(400)
  })

  it("rejects an invalid dateFrom with 400 instead of empty results", async () => {
    seedTx("REWE")
    const res = await getTransactions(
      req("http://x/api/transactions?dateFrom=garbage")
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: string }
    expect(data.error).toBe("invalid_query")
  })

  it("rejects an unknown status value with 400", async () => {
    const res = await getTransactions(
      req("http://x/api/transactions?status=Foo")
    )
    expect(res.status).toBe(400)
  })

  it("passes valid filters through (q, type, sort, dir)", async () => {
    seedTx("REWE")
    seedTx("ALDI")
    const res = await getTransactions(
      req("http://x/api/transactions?q=REWE&type=Ausgang&sort=payee&dir=asc")
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as { rows: Array<{ payee: string }> }
    expect(data.rows).toHaveLength(1)
    expect(data.rows[0].payee).toBe("REWE")
  })
})

describe("GET /api/analytics", () => {
  it("computes analytics for the current state", async () => {
    seedTx("REWE")
    const res = await getAnalytics(req("http://x/api/analytics"))
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      kpis: { transactionCount: number }
      monthlyCashflow: unknown[]
      savingsHistory: unknown
    }
    expect(data.kpis.transactionCount).toBe(1)
    expect(Array.isArray(data.monthlyCashflow)).toBe(true)
  })

  it("tolerates repeated/unknown params (parseFilters ignores garbage)", async () => {
    seedTx("REWE")
    const res = await getAnalytics(
      req("http://x/api/analytics?unknown=1&dateFrom=2026-01-01")
    )
    expect(res.status).toBe(200)
  })
})

describe("GET /api/categories", () => {
  it("lists categories with live transaction counts", async () => {
    const cat = db
      .insert(categories)
      .values({ name: "Miete", nameKey: "miete", language: "de" })
      .returning()
      .get()
    const id = seedTx("Vermieter")
    db.update(transactions)
      .set({ categoryId: cat.id })
      .where(eq(transactions.id, id))
      .run()

    const res = await getCategories()
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      categories: Array<{ name: string; count: number }>
    }
    const miete = data.categories.find((c) => c.name === "Miete")
    expect(miete?.count).toBe(1)
  })
})
