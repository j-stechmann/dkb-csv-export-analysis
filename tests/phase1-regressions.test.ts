import { describe, it, expect, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import { accounts, importBatches, transactions } from "@/lib/db/schema"
import {
  GET as getAccounts,
  POST as postAccount,
} from "@/app/api/accounts/route"
import { computeAnalytics } from "@/lib/analytics/engine"
import { parseFilters, queryTransactions } from "@/lib/analytics/queries"

describe("LIKE escaping in search (q)", () => {
  let db: Db
  let accountId: number

  beforeEach(() => {
    db = createTestDb()
    setTestDb(db)
    accountId = db
      .insert(accounts)
      .values({ iban: "DE02120300000000202051", name: "Girokonto" })
      .returning()
      .get().id
    db.insert(importBatches)
      .values({ id: "b1", fileName: "b1.csv", accountId, status: "completed" })
      .run()
  })

  function seed(payee: string): string {
    const id = `tx-${crypto.randomUUID()}`
    db.insert(transactions)
      .values({
        id,
        accountId,
        bookingDate: "2026-01-10",
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

  it("q containing % matches the literal percent (regression: matched nothing before)", async () => {
    const hit = seed("50% Rabatt")
    seed("50X Rabatt")
    const page = queryTransactions(
      parseFilters(new URLSearchParams("q=50% Rabatt")),
      1,
      50
    )
    expect(page.rows.map((x) => x.id)).toEqual([hit])
    // the near-miss row must NOT match
    expect(page.rows).toHaveLength(1)
  })

  it("q containing _ matches the literal underscore, not any single char", async () => {
    const hit = seed("foo_bar")
    seed("fooXbar")
    const page = queryTransactions(
      parseFilters(new URLSearchParams("q=foo_bar")),
      1,
      50
    )
    expect(page.rows.map((x) => x.id)).toEqual([hit])
  })

  it("q containing a backslash matches the literal backslash", async () => {
    const hit = seed("a\\b")
    const page = queryTransactions(
      parseFilters(new URLSearchParams("q=a\\b")),
      1,
      50
    )
    expect(page.rows.map((x) => x.id)).toEqual([hit])
  })

  it("unescaped wildcard still works as before (substring match)", async () => {
    seed("REWE SAGT DANKE")
    const page = queryTransactions(
      parseFilters(new URLSearchParams("q=REWE")),
      1,
      50
    )
    expect(page.rows).toHaveLength(1)
  })

  it("malformed date filters are dropped instead of silently matching nothing", async () => {
    seed("REWE")
    const garbage = queryTransactions(
      parseFilters(new URLSearchParams("dateFrom=garbage")),
      1,
      50
    )
    expect(garbage.rows).toHaveLength(1)
  })
})

describe("POST /api/accounts", () => {
  let db: Db

  beforeEach(() => {
    db = createTestDb()
    setTestDb(db)
  })

  const req = (body: unknown) =>
    new NextRequest(
      new Request("http://x/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    )

  it("creates an account (201) and returns it", async () => {
    const res = await postAccount(
      req({ iban: " de02 1203 0000 0000 2020 51 ", name: " Girokonto " })
    )
    expect(res.status).toBe(201)
    const data = (await res.json()) as { account: { iban: string } }
    expect(data.account.iban).toBe("DE02120300000000202051")
  })

  it("duplicate IBAN returns 409 with the existing account, never an empty 201", async () => {
    await postAccount(req({ iban: "DE02120300000000202051", name: "A" }))
    const res = await postAccount(
      req({ iban: "DE02120300000000202051", name: "B" })
    )
    expect(res.status).toBe(409)
    const data = (await res.json()) as {
      error: string
      account: { name: string }
    }
    expect(data.error).toBe("account_exists")
    // the survivor is the ORIGINAL account
    expect(data.account.name).toBe("A")
    // exactly one account row
    const rows = db.select().from(accounts).all()
    expect(rows).toHaveLength(1)
  })

  it("rejects a malformed IBAN with 400", async () => {
    const res = await postAccount(req({ iban: "not-an-iban", name: "X" }))
    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: string }
    expect(data.error).toBe("invalid_body")
  })

  it("rejects a missing body with 400", async () => {
    const res = await postAccount(req(null))
    expect(res.status).toBe(400)
  })

  it("GET lists accounts", async () => {
    await postAccount(req({ iban: "DE02120300000000202051", name: "A" }))
    const res = await getAccounts()
    expect(res.status).toBe(200)
    const data = (await res.json()) as { accounts: unknown[] }
    expect(data.accounts).toHaveLength(1)
  })
})

describe("KPI averages are data-bounded", () => {
  let db: Db
  let accountId: number

  beforeEach(() => {
    db = createTestDb()
    setTestDb(db)
    accountId = db
      .insert(accounts)
      .values({ iban: "DE02120300000000202051", name: "Girokonto" })
      .returning()
      .get().id
    db.insert(importBatches)
      .values({ id: "b1", fileName: "b1.csv", accountId, status: "completed" })
      .run()
    // two full months of data: 2026-01 and 2026-02
    for (const m of ["2026-01-05", "2026-02-05"]) {
      db.insert(transactions)
        .values({
          id: `tx-${m}`,
          accountId,
          bookingDate: m,
          status: "Gebucht",
          payee: "REWE",
          type: "Ausgang",
          amountCents: -1000,
          sourceHash: `hash-${m}`,
          occurrenceIndex: 0,
          labelStatus: "pending",
        })
        .run()
    }
  })

  it("dateTo beyond the data does not dilute averages with structural zeros", () => {
    const r = computeAnalytics(
      parseFilters(new URLSearchParams("dateTo=2026-12-31")),
      "2026-08-28"
    )
    // series still zero-fills up to dateTo for display...
    expect(r.monthlyCashflow.map((m) => m.month)).toContain("2026-12")
    // ...but averages count only months with data
    expect(r.kpis.monthsCounted).toBe(2)
    expect(r.kpis.avgMonthlyExpensesCents).toBe(1000)
  })

  it("no dateTo: monthsCounted covers data months only (anchor test)", () => {
    const r = computeAnalytics(
      parseFilters(new URLSearchParams()),
      "2026-08-28"
    )
    expect(r.kpis.monthsCounted).toBe(2)
    expect(r.kpis.avgMonthlyExpensesCents).toBe(1000)
  })

  it("mid-month dateTo still excludes the partial month", () => {
    const r = computeAnalytics(
      parseFilters(new URLSearchParams("dateTo=2026-02-15")),
      "2026-08-28"
    )
    expect(r.kpis.monthsCounted).toBe(1)
    expect(r.kpis.avgMonthlyExpensesCents).toBe(1000)
  })
})
