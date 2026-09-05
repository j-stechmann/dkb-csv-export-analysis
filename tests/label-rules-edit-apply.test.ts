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
import { findIbanRuleMatches } from "@/lib/labeller/service"
import { computeLabelCounters } from "@/lib/import/counters"

const ACC_IBAN = "DE02120300000000202051"
const CP_IBAN = "de02 1203 0000 0000 2020 51"
const CP_IBAN_KEY = "DE02120300000000202051"

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
  overrides: Partial<{ iban: string; nameKey: string; name: string }> = {}
): number {
  return db
    .insert(labelRules)
    .values({
      labelId,
      iban: CP_IBAN_KEY,
      nameKey: "vermieter",
      name: "Vermieter GmbH",
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
      payee: "Vermieter GmbH",
      counterpartyIban: CP_IBAN,
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
  it("edits label, iban and name with normalized keys", async () => {
    const labelA = seedLabel("Miete")
    const labelB = seedLabel("Strom")
    const ruleId = seedRule(labelA)

    const out = await patchRule(
      jsonReq(`http://test/api/label-rules/${ruleId}`, {
        labelId: labelB,
        iban: " de89 3704 0044 0532 0130 00 ",
        name: "  Stadtwerke  AG  ",
      }),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(200)

    const rule = db.select().from(labelRules).all()[0]
    expect(rule.labelId).toBe(labelB)
    expect(rule.iban).toBe("DE89370400440532013000")
    expect(rule.nameKey).toBe("stadtwerke")
    expect(rule.name).toBe("Stadtwerke AG")
  })

  it("keeps the rule when only the display name is reformatted", async () => {
    const labelId = seedLabel("Miete")
    const ruleId = seedRule(labelId, { name: "Vermieter GmbH" })

    const out = await patchRule(
      jsonReq(`http://test/api/label-rules/${ruleId}`, {
        labelId,
        iban: CP_IBAN_KEY,
        name: "Vermieter  GmbH",
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
        iban: CP_IBAN_KEY,
        name: "X",
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
        iban: CP_IBAN_KEY,
        name: "X",
      }),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(404)
    const data = (await out.json()) as { error: string }
    expect(data.error).toBe("label_not_found")
  })

  it("rejects a non-learnable iban with 400", async () => {
    const labelId = seedLabel("Miete")
    const ruleId = seedRule(labelId)

    const out = await patchRule(
      jsonReq(`http://test/api/label-rules/${ruleId}`, {
        labelId,
        iban: "IBAN123",
        name: "X",
      }),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(400)
    const data = (await out.json()) as { error: string }
    expect(data.error).toBe("invalid_iban")
  })

  it("rejects a name that normalizes to empty with 400", async () => {
    const labelId = seedLabel("Miete")
    const ruleId = seedRule(labelId)

    const out = await patchRule(
      jsonReq(`http://test/api/label-rules/${ruleId}`, {
        labelId,
        iban: CP_IBAN_KEY,
        name: "GmbH",
      }),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(400)
    const data = (await out.json()) as { error: string }
    expect(data.error).toBe("invalid_name")
  })

  it("rejects a body targeting another rule's key with 409", async () => {
    const labelId = seedLabel("Miete")
    seedRule(labelId, { nameKey: "other", name: "Other" })
    const ruleId = seedRule(labelId, { nameKey: "mine", name: "Mine" })

    const out = await patchRule(
      jsonReq(`http://test/api/label-rules/${ruleId}`, {
        labelId,
        iban: CP_IBAN_KEY,
        name: "Other",
      }),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(409)
    const data = (await out.json()) as { error: string }
    expect(data.error).toBe("rule_conflict")
  })

  it("maps a unique-constraint violation on update to 409", async () => {
    const labelId = seedLabel("Miete")
    seedRule(labelId, { nameKey: "other", name: "Other" })
    const ruleId = seedRule(labelId, { nameKey: "mine", name: "Mine" })
    // simulate the concurrent-write window: the advisory pre-check passes,
    // then the UPDATE hits the unique index (as a racing learnRule would)
    db.run(
      `CREATE TRIGGER simulate_rule_race BEFORE UPDATE ON label_rules
       WHEN NEW.name_key = 'other'
       BEGIN
         SELECT RAISE(ABORT, 'UNIQUE constraint failed: label_rules.iban, label_rules.name_key');
       END`
    )

    const out = await patchRule(
      jsonReq(`http://test/api/label-rules/${ruleId}`, {
        labelId,
        iban: CP_IBAN_KEY,
        name: "Other",
      }),
      ruleParams(ruleId)
    )
    expect(out.status).toBe(409)
  })

  it("rejects a malformed body with 400", async () => {
    const out = await patchRule(
      jsonReq("http://test/api/label-rules/1", { iban: CP_IBAN_KEY }),
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
        iban: CP_IBAN_KEY,
        name: "X",
      }),
      ruleParams("abc")
    )
    expect(out.status).toBe(400)
  })
})

describe("findIbanRuleMatches", () => {
  it("matches case/space-insensitively and excludes null/foreign ibans", () => {
    const a = seedTx(null)
    const b = seedTx(null, { counterpartyIban: CP_IBAN_KEY })
    seedTx(null, { counterpartyIban: null })
    seedTx(null, { counterpartyIban: "DE00999999990000000099" })

    const matches = findIbanRuleMatches(db, CP_IBAN_KEY)
    expect(matches.map((m) => m.id).sort()).toEqual([a, b].sort())
  })
})

describe("GET /api/label-rules/[id]/matches", () => {
  it("counts only Gebucht rows matching the rule iban", async () => {
    const labelId = seedLabel("Miete")
    const ruleId = seedRule(labelId)
    seedTx(null)
    seedTx(null, { status: "Nicht gebucht" })
    seedTx(null, { counterpartyIban: null })

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
    const applied = rows.find((r) => r.counterpartyIban === CP_IBAN)!
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
    const suggested = suggestLabelIds(db, claimed[0].counterpartyIban)
    expect(suggested).toEqual([labelId])
  })
})

describe("PATCH + apply round-trip", () => {
  it("edited iban matches the new counterparty on apply", async () => {
    const labelA = seedLabel("Miete")
    const labelB = seedLabel("Strom")
    const ruleId = seedRule(labelA)
    const otherIban = "DE89370400440532013000"
    seedTx(null, { counterpartyIban: otherIban })

    const patched = await patchRule(
      jsonReq(`http://test/api/label-rules/${ruleId}`, {
        labelId: labelB,
        iban: otherIban,
        name: "Stadtwerke AG",
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
