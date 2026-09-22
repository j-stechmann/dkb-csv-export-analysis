import { describe, it, expect, beforeEach } from "vitest"
import { and, eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import {
  accounts,
  categories,
  importBatches,
  labelRules,
  transactions,
} from "@/lib/db/schema"
import {
  TEST_ISSUER,
  TEST_SUBJECT,
  authedRequest,
  seedUser,
  setupTestDb,
} from "./helpers"
import { computeAnalytics } from "@/lib/analytics/engine"
import { parseFilters, queryTransactions } from "@/lib/analytics/queries"
import { GET as listLabels } from "@/app/api/labels/route"
import { GET as listAccounts } from "@/app/api/accounts/route"
import { DELETE as deleteAccount } from "@/app/api/accounts/route"
import { GET as listBatches } from "@/app/api/imports/history/route"
import { POST as assignLabel } from "@/app/api/transactions/[id]/label/route"
import { claimLabelRows } from "@/lib/labeller/worker"
import { suggestLabelIds } from "@/lib/labels/matching"
import { getSession } from "@/lib/auth/session-helpers"
import { unauthorized } from "@/lib/auth/guard"

const IBAN = "DE02120300000000202051"

let db: ReturnType<typeof setupTestDb>["db"]
let userA: number
let userB: number

beforeEach(() => {
  ;({ db, userId: userA } = setupTestDb())
  userB = seedUser(db, "user-2")
  seedIbans.clear()
})

function seedTx(
  userId: number,
  overrides: Partial<{
    payee: string
    amountCents: number
    bookingDate: string
  }> = {}
): string {
  const id = `tx-${crypto.randomUUID()}`
  db.insert(transactions)
    .values({
      id,
      userId,
      accountId: seedAccountFor(userId),
      bookingDate: overrides.bookingDate ?? "2026-02-03",
      status: "Gebucht",
      payer: "Max Mustermann",
      payee: overrides.payee ?? "Vermieter GmbH",
      counterpartyIban: IBAN,
      type: "Ausgang",
      amountCents: overrides.amountCents ?? -100,
      sourceHash: `hash-${id}`,
    })
    .run()
  return id
}

let accountCounter = 0
const seedIbans = new Map<number, string>()
function seedAccountFor(userId: number): number {
  accountCounter++
  const iban = `DE00AA${String(accountCounter).padStart(18, "0")}`
  const id = db
    .insert(accounts)
    .values({
      userId,
      iban,
      name: "Konto",
    })
    .returning()
    .get().id
  seedIbans.set(id, iban)
  return id
}

describe("session helpers", () => {
  it("resolves a valid cookie", async () => {
    const req = await authedRequest("http://test/api/x", userA)
    const session = await getSession(req)
    expect(session).not.toBeNull()
    expect(session!.uid).toBe(userA)
    expect(session!.sub).toBe(TEST_SUBJECT)
    expect(session!.iss).toBe(TEST_ISSUER)
  })

  it("returns null without a cookie", async () => {
    const req = new NextRequest(new Request("http://test/api/x"))
    expect(await getSession(req)).toBeNull()
  })

  it("returns null for a tampered token", async () => {
    const req = await authedRequest("http://test/api/x", userA)
    const header = req.headers.get("cookie")!
    const value = header.split("=")[1]
    const tampered = value.slice(0, -4) + "AAAA"
    const req2 = new NextRequest(
      new Request("http://test/api/x", {
        headers: { cookie: `geldlage_session=${tampered}` },
      })
    )
    expect(await getSession(req2)).toBeNull()
  })

  it("unauthorized() is a 401 JSON response", () => {
    const res = unauthorized()
    expect(res.status).toBe(401)
  })
})

describe("per-user data isolation", () => {
  it("queryTransactions only returns the owner's rows", () => {
    const a = seedTx(userA)
    seedTx(userB)
    const page = queryTransactions(
      parseFilters(new URLSearchParams()),
      userA,
      1,
      25
    )
    expect(page.rows.map((r) => r.id)).toEqual([a])
    expect(page.total).toBe(1)
  })

  it("computeAnalytics is scoped to the owner", () => {
    seedTx(userA, { amountCents: -1000 })
    seedTx(userB, { amountCents: -99000 })
    const filters = {
      ...parseFilters(new URLSearchParams()),
      status: "all" as const,
    }
    const a = computeAnalytics(filters, userA, "2026-02-28")
    expect(a.kpis.transactionCount).toBe(1)
    const b = computeAnalytics(filters, userB, "2026-02-28")
    expect(b.kpis.transactionCount).toBe(1)
    void b
  })

  it("accounts route lists only the owner's accounts", async () => {
    seedAccountFor(userA)
    seedAccountFor(userB)
    const req = await authedRequest("http://test/api/accounts", userA)
    const res = await listAccounts(req)
    const data = (await res.json()) as { accounts: Array<{ userId: number }> }
    expect(data.accounts).toHaveLength(1)
    expect(data.accounts[0].userId).toBe(userA)
  })

  it("imports history route lists only the owner's batches", async () => {
    const batchId = `b-${crypto.randomUUID()}`
    db.insert(importBatches)
      .values({
        id: batchId,
        userId: userB,
        fileName: "x.csv",
        status: "completed",
      })
      .run()
    const req = await authedRequest("http://test/api/imports/history", userA)
    const res = await listBatches(req)
    const data = (await res.json()) as { batches: unknown[] }
    expect(data.batches).toHaveLength(0)
  })

  it("labels route lists only the owner's labels", async () => {
    db.insert(categories)
      .values({ userId: userA, name: "A", nameKey: "a", language: "de" })
      .run()
    db.insert(categories)
      .values({ userId: userB, name: "B", nameKey: "b", language: "de" })
      .run()
    const req = await authedRequest("http://test/api/labels", userA)
    const res = await listLabels(req)
    const data = (await res.json()) as { labels: Array<{ name: string }> }
    expect(data.labels.map((l) => l.name)).toEqual(["A"])
  })

  it("manual label assignment rejects another user's transaction with 404", async () => {
    const txId = seedTx(userB)
    const labelId = db
      .insert(categories)
      .values({ userId: userB, name: "B", nameKey: "b", language: "de" })
      .returning()
      .get().id
    const req = await authedRequest(
      `http://test/api/transactions/${txId}/label`,
      userA,
      { method: "POST", body: { labelId } }
    )
    const res = await assignLabel(req, {
      params: Promise.resolve({ id: txId }),
    })
    expect(res.status).toBe(404)
    const row = db
      .select()
      .from(transactions)
      .where(eq(transactions.id, txId))
      .get()
    expect(row!.categoryId).toBeNull()
  })

  it("rule suggestions are scoped per user (same triple, different owners)", () => {
    const mieteA = db
      .insert(categories)
      .values({
        userId: userA,
        name: "Miete",
        nameKey: "miete",
        language: "de",
      })
      .returning()
      .get().id
    db.insert(labelRules)
      .values({
        userId: userA,
        labelId: mieteA,
        payer: "Max Mustermann",
        payee: "Vermieter GmbH",
        counterpartyIban: IBAN,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run()

    expect(
      suggestLabelIds(db, userA, {
        payer: "Max Mustermann",
        payee: "Vermieter GmbH",
        counterpartyIban: IBAN,
      })
    ).toEqual([mieteA])
    expect(
      suggestLabelIds(db, userB, {
        payer: "Max Mustermann",
        payee: "Vermieter GmbH",
        counterpartyIban: IBAN,
      })
    ).toEqual([])
  })

  it("worker claim spans users and carries userId for per-owner suggestions", () => {
    const aId = seedTx(userA)
    const bId = seedTx(userB)
    const claimed = claimLabelRows(10, 5)
    expect(claimed).toHaveLength(2)
    const byId = new Map(claimed.map((c) => [c.id, c]))
    expect(byId.get(aId)!.userId).toBe(userA)
    expect(byId.get(bId)!.userId).toBe(userB)
  })

  it("same IBAN can exist for two users (isolated account namespace)", () => {
    const iban = IBAN
    const a1 = db
      .insert(accounts)
      .values({ userId: userA, iban, name: "A Giro" })
      .returning()
      .get()
    const b1 = db
      .insert(accounts)
      .values({ userId: userB, iban, name: "B Giro" })
      .returning()
      .get()
    expect(a1.userId).toBe(userA)
    expect(b1.userId).toBe(userB)
    expect(a1.id).not.toBe(b1.id)
    const rows = db.select().from(accounts).all()
    expect(rows).toHaveLength(2)
    void and
  })

  it("deleting an account with transactions returns 409 account_in_use", async () => {
    const acc = seedAccountFor(userA)
    const txId = `tx-${crypto.randomUUID()}`
    db.insert(transactions)
      .values({
        id: txId,
        userId: userA,
        accountId: acc,
        bookingDate: "2026-02-03",
        status: "Gebucht",
        payer: "Max Mustermann",
        payee: "Vermieter GmbH",
        counterpartyIban: IBAN,
        type: "Ausgang",
        amountCents: -100,
        sourceHash: `hash-${txId}`,
      })
      .run()
    const req = await authedRequest(
      `http://test/api/accounts?iban=${seedIbans.get(acc)}`,
      userA,
      { method: "DELETE" }
    )
    const res = await deleteAccount(req)
    expect(res.status).toBe(409)
    const data = (await res.json()) as { error: string }
    expect(data.error).toBe("account_in_use")
    expect(db.select().from(accounts).all()).toHaveLength(1)
  })

  it("deleting an unused account succeeds", async () => {
    const acc = seedAccountFor(userA)
    const req = await authedRequest(
      `http://test/api/accounts?iban=${seedIbans.get(acc)}`,
      userA,
      { method: "DELETE" }
    )
    const res = await deleteAccount(req)
    expect(res.status).toBe(200)
    expect(db.select().from(accounts).all()).toHaveLength(0)
  })

  it("delete account rejects another user's account with 404", async () => {
    const acc = seedAccountFor(userB)
    const req = await authedRequest(
      `http://test/api/accounts?iban=${seedIbans.get(acc)}`,
      userA,
      { method: "DELETE" }
    )
    const res = await deleteAccount(req)
    expect(res.status).toBe(404)
    expect(db.select().from(accounts).all()).toHaveLength(1)
  })
})
