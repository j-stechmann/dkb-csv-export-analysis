import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import {
  accounts,
  categories,
  importBatches,
  labelRules,
  transactions,
} from "@/lib/db/schema"
import {
  PATCH as patchRule,
  DELETE as deleteRule,
} from "@/app/api/label-rules/[id]/route"
import { GET as countMatches } from "@/app/api/label-rules/[id]/matches/route"
import { POST as applyRule } from "@/app/api/label-rules/[id]/apply/route"
import { findRuleMatches } from "@/lib/labeller/service"
import { computeLabelCounters } from "@/lib/import/counters"

const ACC_IBAN = "DE02120300000000202051"
const PAYER = "Max Mustermann"
const PAYEE = "Vermieter GmbH"

let db: Db
let accountId: number
let batchCounter = 0

function jsonReq(url: string, body: unknown, method = "PATCH"): NextRequest {
  return new NextRequest(
    new Request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

function ruleParams(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) }
}

function seedLabel(name: string, nameKey?: string): number {
  return db
    .insert(categories)
    .values({
      name,
      nameKey: nameKey ?? name.toLowerCase(),
      language: "de",
      origin: "manual",
    })
    .returning()
    .get().id
}

function seedRule(
  labelId: number,
  overrides: Partial<{
    payer: string
    payee: string
    counterpartyIban: string
  }> = {}
): number {
  return db
    .insert(labelRules)
    .values({
      labelId,
      payer: PAYER,
      payee: PAYEE,
      counterpartyIban: ACC_IBAN,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    })
    .returning()
    .get().id
}

function seedBatch(status = "labeling"): string {
  batchCounter++
  const id = `b${batchCounter}`
  db.insert(importBatches)
    .values({ id, fileName: `${id}.csv`, accountId, status })
    .run()
  return id
}

function seedTx(
  batchId: string | null,
  overrides: Partial<{
    status: string
    payer: string | null
    payee: string | null
    counterpartyIban: string | null
    labelStatus: string
    labelAttempts: number
    categoryId: number | null
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
      payer: PAYER,
      payee: PAYEE,
      counterpartyIban: ACC_IBAN,
      type: "Ausgang",
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
    .values({ iban: ACC_IBAN, name: "Girokonto" })
    .returning()
    .get().id
})

describe("PATCH /api/label-rules/[id]", () => {
  it("edits label, payer, payee and iban verbatim", async () => {
    const labelA = seedLabel("Miete")
    const labelB = seedLabel("Strom")
    const ruleId = seedRule(labelA)

    const out = await patchRule(
      jsonReq(`http://test/api/label-rules/${ruleId}`, {
        labelId: labelB,
        payer: " Stadtwerke AG ",
        payee: "Max Mustermann",
        counterpartyIban: "DE89370400440532013000",
      }),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(200)

    const rule = db.select().from(labelRules).all()[0]
    expect(rule.labelId).toBe(labelB)
    expect(rule.payer).toBe(" Stadtwerke AG ")
    expect(rule.payee).toBe("Max Mustermann")
    expect(rule.counterpartyIban).toBe("DE89370400440532013000")
  })

  it("keeps the rule when the same triple is re-submitted", async () => {
    const labelId = seedLabel("Miete")
    const ruleId = seedRule(labelId)

    const out = await patchRule(
      jsonReq(`http://test/api/label-rules/${ruleId}`, {
        labelId,
        payer: PAYER,
        payee: PAYEE,
        counterpartyIban: ACC_IBAN,
      }),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(200)
    expect(db.select().from(labelRules).all()).toHaveLength(1)
  })

  it("rejects an unknown rule with 404", async () => {
    const out = await patchRule(
      jsonReq("http://test/api/label-rules/999", {
        labelId: 1,
        payer: PAYER,
        payee: PAYEE,
        counterpartyIban: ACC_IBAN,
      }),
      ruleParams(999)
    )
    expect(out.status).toBe(404)
  })

  it("rejects an unknown target label with label_not_found", async () => {
    const labelId = seedLabel("Miete")
    const ruleId = seedRule(labelId)

    const out = await patchRule(
      jsonReq(`http://test/api/label-rules/${ruleId}`, {
        labelId: 999,
        payer: PAYER,
        payee: PAYEE,
        counterpartyIban: ACC_IBAN,
      }),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(404)
    const data = (await out.json()) as { error: string }
    expect(data.error).toBe("label_not_found")
  })

  it("rejects empty or whitespace-only fields with 400", async () => {
    const labelId = seedLabel("Miete")
    const ruleId = seedRule(labelId)

    for (const body of [
      { labelId, payer: "", payee: PAYEE, counterpartyIban: ACC_IBAN },
      { labelId, payer: "   ", payee: PAYEE, counterpartyIban: ACC_IBAN },
      { labelId, payer: PAYER, payee: "", counterpartyIban: ACC_IBAN },
      { labelId, payer: PAYER, payee: PAYEE, counterpartyIban: "   " },
    ]) {
      const out = await patchRule(
        jsonReq(`http://test/api/label-rules/${ruleId}`, body),
        ruleParams(ruleId)
      )
      expect(out.status).toBe(400)
    }
    expect(db.select().from(labelRules).all()).toHaveLength(1)
  })

  it("rejects a body targeting another rule's triple with 409", async () => {
    const labelId = seedLabel("Miete")
    seedRule(labelId, { payee: "Other Payee" })
    const ruleId = seedRule(labelId)

    const out = await patchRule(
      jsonReq(`http://test/api/label-rules/${ruleId}`, {
        labelId,
        payer: PAYER,
        payee: "Other Payee",
        counterpartyIban: ACC_IBAN,
      }),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(409)
    const data = (await out.json()) as { error: string }
    expect(data.error).toBe("rule_conflict")
  })

  it("maps a unique-constraint violation on update to 409", async () => {
    const labelId = seedLabel("Miete")
    seedRule(labelId, { payee: "Other Payee" })
    const ruleId = seedRule(labelId)
    // simulate the concurrent-write window: the advisory pre-check passes,
    // then the UPDATE hits the unique index (as a racing learnRule would)
    db.run(
      `CREATE TRIGGER simulate_rule_race BEFORE UPDATE ON label_rules
       WHEN NEW.payee = 'Other Payee'
       BEGIN
         SELECT RAISE(ABORT, 'UNIQUE constraint failed: label_rules.payer, label_rules.payee, label_rules.counterparty_iban');
       END`
    )

    const out = await patchRule(
      jsonReq(`http://test/api/label-rules/${ruleId}`, {
        labelId,
        payer: PAYER,
        payee: "Other Payee",
        counterpartyIban: ACC_IBAN,
      }),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(409)
  })

  it("rejects a malformed body with 400", async () => {
    const out = await patchRule(
      jsonReq("http://test/api/label-rules/1", {
        payer: PAYER,
        payee: PAYEE,
      }),
      ruleParams(1)
    )
    expect(out.status).toBe(400)
    const data = (await out.json()) as { error: string }
    expect(data.error).toBe("invalid_body")
  })

  it("rejects an invalid id with 400", async () => {
    const out = await patchRule(
      jsonReq("http://test/api/label-rules/abc", {
        labelId: 1,
        payer: PAYER,
        payee: PAYEE,
        counterpartyIban: ACC_IBAN,
      }),
      ruleParams("abc")
    )
    expect(out.status).toBe(400)
  })
})

describe("findRuleMatches", () => {
  it("matches the exact triple and excludes differing/null values", () => {
    const a = seedTx(null)
    seedTx(null, { counterpartyIban: null })
    seedTx(null, { payee: "Other Payee" })
    seedTx(null, { payer: null })
    // no normalization: a space-padded IBAN rendering is a different value
    seedTx(null, { counterpartyIban: " DE02120300000000202051 " })

    const matches = findRuleMatches(db, PAYER, PAYEE, ACC_IBAN)
    expect(matches.map((m) => m.id)).toEqual([a])
  })

  it("excludes rows already carrying the excluded label", () => {
    const labelId = seedLabel("Miete")
    const otherLabel = seedLabel("Strom")
    seedTx(null, { categoryId: labelId, labelStatus: "pending" })
    seedTx(null, {
      categoryId: labelId,
      labelStatus: "labeled",
    })
    seedTx(null, { categoryId: labelId, labelStatus: "failed" })
    const other = seedTx(null, { categoryId: otherLabel })
    const fresh = seedTx(null)

    const matches = findRuleMatches(db, PAYER, PAYEE, ACC_IBAN, labelId)
    expect(matches.map((m) => m.id).sort()).toEqual([fresh, other].sort())
    // without exclusion, all five rows match
    expect(findRuleMatches(db, PAYER, PAYEE, ACC_IBAN)).toHaveLength(5)
  })
})

describe("GET /api/label-rules/[id]/matches", () => {
  it("counts only Gebucht rows matching the rule triple", async () => {
    const labelId = seedLabel("Miete")
    const ruleId = seedRule(labelId)
    seedTx(null)
    seedTx(null, { status: "Nicht gebucht" })
    seedTx(null, { counterpartyIban: null })
    seedTx(null, { payee: "Other Payee" })

    const res = await countMatches(
      new NextRequest(
        new Request(`http://x/api/label-rules/${ruleId}/matches`)
      ),
      ruleParams(ruleId)
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as { count: number }
    expect(data.count).toBe(1)
  })

  it("excludes rows already at the rule's label from the count", async () => {
    const labelId = seedLabel("Miete")
    const ruleId = seedRule(labelId)
    seedTx(null)
    seedTx(null, { categoryId: labelId, labelStatus: "pending" })

    const res = await countMatches(
      new NextRequest(
        new Request(`http://x/api/label-rules/${ruleId}/matches`)
      ),
      ruleParams(ruleId)
    )
    const data = (await res.json()) as { count: number }
    expect(data.count).toBe(1)
  })

  it("returns 404 for unknown rules", async () => {
    const res = await countMatches(
      new NextRequest(new Request("http://x/api/label-rules/999/matches")),
      ruleParams(999)
    )
    expect(res.status).toBe(404)
  })
})

describe("POST /api/label-rules/[id]/apply", () => {
  it("resets matching Gebucht rows to pending with the rule's label", async () => {
    const labelId = seedLabel("Miete")
    const ruleId = seedRule(labelId)
    const batchId = seedBatch("completed")
    seedTx(batchId, {
      labelStatus: "labeled",
      labelAttempts: 2,
      categoryId: null,
    })
    seedTx(batchId, { status: "Nicht gebucht", labelStatus: "labeled" })
    seedTx(batchId, { counterpartyIban: null, labelStatus: "labeled" })

    const out = await applyRule(
      new NextRequest(
        new Request(`http://x/api/label-rules/${ruleId}/apply`, {
          method: "POST",
        })
      ),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(200)
    const data = (await out.json()) as { applied: number }
    expect(data.applied).toBe(1)

    const rows = db.select().from(transactions).all()
    const applied = rows.find((r) => r.counterpartyIban === ACC_IBAN)!
    expect(applied.categoryId).toBe(labelId)
    expect(applied.labelStatus).toBe("pending")
    expect(applied.labelAttempts).toBe(0)
    // untouched rows stay labeled
    expect(rows.find((r) => r.status === "Nicht gebucht")!.labelStatus).toBe(
      "labeled"
    )
    expect(rows.find((r) => r.counterpartyIban === null)!.labelStatus).toBe(
      "labeled"
    )
  })

  it("overrides manual labels and re-points completed batches", async () => {
    const labelOld = seedLabel("Alt")
    const labelNew = seedLabel("Neu")
    const ruleId = seedRule(labelNew)
    const completedId = seedBatch("completed")
    const labelingId = seedBatch("labeling")
    const failedId = seedBatch("failed")
    db.update(importBatches)
      .set({ labelsTotal: 3 })
      .where(eq(importBatches.id, completedId))
      .run()
    const c = seedTx(completedId, {
      labelStatus: "labeled",
      labelAttempts: 1,
      categoryId: labelOld,
    })
    const l = seedTx(labelingId, {
      labelStatus: "labeled",
      categoryId: labelOld,
    })
    const f = seedTx(failedId, { labelStatus: "labeled", categoryId: labelOld })

    const out = await applyRule(
      new NextRequest(
        new Request(`http://x/api/label-rules/${ruleId}/apply`, {
          method: "POST",
        })
      ),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(200)
    const data = (await out.json()) as { applied: number }
    expect(data.applied).toBe(3)

    for (const id of [c, l, f]) {
      const row = getTx(id)!
      expect(row.categoryId).toBe(labelNew)
      expect(row.labelStatus).toBe("pending")
      expect(row.labelAttempts).toBe(0)
    }

    expect(getBatch(completedId)!.status).toBe("labeling")
    expect(getBatch(labelingId)!.status).toBe("labeling")
    expect(getBatch(failedId)!.status).toBe("failed")

    const counters = computeLabelCounters(completedId)
    expect(counters).toEqual({ labelsTotal: 1, labelsDone: 0, labelsFailed: 0 })
    // stored labels_total was refreshed (Gebucht count, not matched count)
    expect(getBatch(completedId)!.labelsTotal).toBe(1)
  })

  it("leaves failed and parsing batches untouched but rows claimable", async () => {
    const labelId = seedLabel("Miete")
    const ruleId = seedRule(labelId)
    const failedId = seedBatch("failed")
    seedTx(failedId, { labelStatus: "labeled", labelAttempts: 5 })

    await applyRule(
      new NextRequest(
        new Request(`http://x/api/label-rules/${ruleId}/apply`, {
          method: "POST",
        })
      ),
      ruleParams(ruleId)
    )

    const row = db.select().from(transactions).all()[0]
    // fresh budget → the worker can claim it even though the batch stays failed
    expect(row.labelStatus).toBe("pending")
    expect(row.labelAttempts).toBe(0)
    expect(getBatch(failedId)!.status).toBe("failed")
  })

  it("returns 404 for unknown rules", async () => {
    const out = await applyRule(
      new NextRequest(
        new Request("http://x/api/label-rules/999/apply", { method: "POST" })
      ),
      ruleParams(999)
    )
    expect(out.status).toBe(404)
  })

  it("leaves rows already at the rule's label untouched", async () => {
    const labelId = seedLabel("Miete")
    const ruleId = seedRule(labelId)
    seedTx(null, {
      categoryId: labelId,
      labelStatus: "labeled",
      labelAttempts: 3,
    })

    const out = await applyRule(
      new NextRequest(
        new Request(`http://x/api/label-rules/${ruleId}/apply`, {
          method: "POST",
        })
      ),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(200)
    const data = (await out.json()) as { applied: number }
    expect(data.applied).toBe(0)

    const row = db.select().from(transactions).all()[0]
    expect(row.categoryId).toBe(labelId)
    expect(row.labelStatus).toBe("labeled")
    expect(row.labelAttempts).toBe(3)
  })

  it("maps a concurrently deleted label to 404 and writes nothing", async () => {
    const labelId = seedLabel("Miete")
    const ruleId = seedRule(labelId)
    seedTx(null)
    // Simulate the concurrent-write window the FK can't produce statically:
    // the route read the rule, then the label vanished before the apply
    // transaction (label delete cascades to rules, but apply already holds
    // the rule's triple/labelId in memory). Drop the label behind the
    // route's back by disabling FK enforcement for the delete.
    db.run("PRAGMA foreign_keys = OFF")
    db.delete(categories).where(eq(categories.id, labelId)).run()
    db.run("PRAGMA foreign_keys = ON")

    const out = await applyRule(
      new NextRequest(
        new Request(`http://x/api/label-rules/${ruleId}/apply`, {
          method: "POST",
        })
      ),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(404)
    // the rule row survived (no cascade — label was force-deleted)
    expect(db.select().from(labelRules).all()).toHaveLength(1)
    // untouched row stays pending with no category
    const row = db.select().from(transactions).all()[0]
    expect(row.categoryId).toBe(null)
    expect(row.labelStatus).toBe("pending")
  })
})

describe("rule apply integrates with the worker", () => {
  afterEach(() => vi.restoreAllMocks())

  it("applied rows are re-claimed and the rule label is suggested in the prompt", async () => {
    const { claimLabelRows } = await import("@/lib/labeller/worker")
    const labelId = seedLabel("Miete")
    const ruleId = seedRule(labelId)
    seedBatch("completed")
    seedTx(null, { labelStatus: "labeled" })

    await applyRule(
      new NextRequest(
        new Request(`http://x/api/label-rules/${ruleId}/apply`, {
          method: "POST",
        })
      ),
      ruleParams(ruleId)
    )

    const claimed = claimLabelRows(10, 5)
    expect(claimed).toHaveLength(1)
    expect(claimed[0].categoryId).toBe(labelId)

    // rule suggestions resolve from the (unchanged) rule
    const { suggestLabelIds } = await import("@/lib/labels/matching")
    const suggested = suggestLabelIds(db, {
      payer: claimed[0].payer!,
      payee: claimed[0].payee!,
      counterpartyIban: claimed[0].counterpartyIban,
    })
    expect(suggested).toEqual([labelId])
  })
})

describe("PATCH + apply round-trip", () => {
  it("edited triple matches the new counterparty on apply", async () => {
    const labelA = seedLabel("Miete")
    const labelB = seedLabel("Strom")
    const ruleId = seedRule(labelA)
    const otherIban = "DE89370400440532013000"
    const otherPayer = "Stadtwerke AG"
    seedTx(null, {
      payer: otherPayer,
      payee: PAYER,
      counterpartyIban: otherIban,
    })

    const patched = await patchRule(
      jsonReq(`http://test/api/label-rules/${ruleId}`, {
        labelId: labelB,
        payer: otherPayer,
        payee: PAYER,
        counterpartyIban: otherIban,
      }),
      ruleParams(ruleId)
    )
    expect(patched.status).toBe(200)

    const res = await countMatches(
      new NextRequest(
        new Request(`http://x/api/label-rules/${ruleId}/matches`)
      ),
      ruleParams(ruleId)
    )
    const data = (await res.json()) as { count: number }
    expect(data.count).toBe(1)

    const out = await applyRule(
      new NextRequest(
        new Request(`http://x/api/label-rules/${ruleId}/apply`, {
          method: "POST",
        })
      ),
      ruleParams(ruleId)
    )
    const applied = (await out.json()) as { applied: number }
    expect(applied.applied).toBe(1)

    const row = db.select().from(transactions).all()[0]
    expect(row.categoryId).toBe(labelB)
    expect(row.labelStatus).toBe("pending")
  })
})

describe("DELETE /api/label-rules/[id] (regression)", () => {
  it("still removes a learned rule", async () => {
    const labelId = seedLabel("Miete")
    const ruleId = seedRule(labelId)

    const out = await deleteRule(
      new NextRequest(
        new Request(`http://x/api/label-rules/${ruleId}`, { method: "DELETE" })
      ),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(200)
    expect(db.select().from(labelRules).all()).toHaveLength(0)
  })
})
