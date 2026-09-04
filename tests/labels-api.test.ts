import { describe, it, expect, beforeEach } from "vitest"
import { eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import { accounts, categories, labelRules, transactions } from "@/lib/db/schema"
import { GET as listLabels, POST as createLabel } from "@/app/api/labels/route"
import {
  PATCH as patchLabel,
  DELETE as deleteLabel,
} from "@/app/api/labels/[id]/route"
import { DELETE as deleteRule } from "@/app/api/label-rules/[id]/route"
import { GET as listRules } from "@/app/api/labels/[id]/rules/route"
import { POST as assignLabel } from "@/app/api/transactions/[id]/label/route"

const IBAN = "DE02120300000000202051"

let db: Db
let accountId: number

function jsonReq(url: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(
    new Request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

function seedTx(
  overrides: Partial<{
    payee: string
    counterpartyIban: string | null
    type: string
    labelStatus: string
    categoryId: number | null
  }> = {}
): string {
  const id = `tx-${crypto.randomUUID()}`
  db.insert(transactions)
    .values({
      id,
      accountId,
      bookingDate: "2026-02-03",
      status: "Gebucht",
      payee: "Vermieter GmbH",
      counterpartyIban: IBAN,
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

beforeEach(() => {
  db = createTestDb()
  setTestDb(db)
  accountId = db
    .insert(accounts)
    .values({ iban: IBAN, name: "Girokonto" })
    .returning()
    .get().id
})

describe("GET /api/labels", () => {
  it("lists labels with usageCount, origin and ruleCount", async () => {
    db.insert(categories)
      .values({
        name: "Miete",
        nameKey: "miete",
        language: "de",
        origin: "manual",
        usageCount: 3,
      })
      .run()

    const res = await listLabels()
    const data = (await res.json()) as {
      labels: Array<{
        id: number
        name: string
        origin: string
        usageCount: number
        ruleCount: number
      }>
    }
    expect(res.status).toBe(200)
    expect(data.labels).toHaveLength(1)
    expect(data.labels[0]).toMatchObject({
      name: "Miete",
      origin: "manual",
      usageCount: 3,
      ruleCount: 0,
    })
  })
})

describe("POST /api/labels", () => {
  it("creates a manual label", async () => {
    const out = await createLabel(
      jsonReq("http://test/api/labels", { name: "Lebensmittel" })
    )
    expect(out.status).toBe(201)
    const data = (await out.json()) as { id: number }
    const row = db.select().from(categories).all()[0]
    expect(row.origin).toBe("manual")
    expect(row.nameKey).toBe("lebensmittel")
    expect(data.id).toBe(row.id)
  })

  it("rejects duplicate names with 409", async () => {
    await createLabel(jsonReq("http://test/api/labels", { name: "Miete" }))
    const out = await createLabel(
      jsonReq("http://test/api/labels", { name: "  miete " })
    )
    expect(out.status).toBe(409)
  })

  it("rejects empty or oversized names with 400", async () => {
    expect(
      (await createLabel(jsonReq("http://test/api/labels", { name: "" })))
        .status
    ).toBe(400)
    expect(
      (
        await createLabel(
          jsonReq("http://test/api/labels", { name: "x".repeat(65) })
        )
      ).status
    ).toBe(400)
    // byte cap matches the LLM-side sanitizeLabel limit
    expect(
      (
        await createLabel(
          jsonReq("http://test/api/labels", { name: "ä".repeat(64) })
        )
      ).status
    ).toBe(400)
  })
})

describe("GET /api/labels/[id]/rules", () => {
  it("returns 404 for an unknown label id", async () => {
    const res = await listRules(
      new NextRequest(new Request("http://x/api/labels/999/rules")),
      { params: Promise.resolve({ id: "999" }) }
    )
    expect(res.status).toBe(404)
  })

  it("returns rules for an existing label", async () => {
    const created = await createLabel(
      jsonReq("http://test/api/labels", { name: "Miete" })
    )
    const { id } = (await created.json()) as { id: number }
    db.insert(labelRules)
      .values({
        labelId: id,
        iban: IBAN,
        nameKey: "vermieter",
        name: "Vermieter GmbH",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run()

    const res = await listRules(
      new NextRequest(new Request(`http://x/api/labels/${id}/rules`)),
      { params: Promise.resolve({ id: String(id) }) }
    )
    expect(res.status).toBe(200)
    const data = (await res.json()) as { rules: Array<{ labelId: number }> }
    expect(data.rules).toHaveLength(1)
    expect(data.rules[0].labelId).toBe(id)
  })
})

describe("PATCH /api/labels/[id]", () => {
  it("renames and flips origin to manual", async () => {
    const created = await createLabel(
      jsonReq("http://test/api/labels", { name: "Alt" })
    )
    const { id } = (await created.json()) as { id: number }
    // simulate an llm-invented label
    db.update(categories)
      .set({ origin: "llm" })
      .where(eq(categories.id, id))
      .run()

    const out = await patchLabel(
      jsonReq(`http://test/api/labels/${id}`, { name: "Neu" }, "PATCH"),
      { params: Promise.resolve({ id: String(id) }) }
    )
    expect(out.status).toBe(200)
    const row = db.select().from(categories).all()[0]
    expect(row.name).toBe("Neu")
    expect(row.nameKey).toBe("neu")
    expect(row.origin).toBe("manual")
  })

  it("rejects renames onto an existing nameKey with 409", async () => {
    await createLabel(jsonReq("http://test/api/labels", { name: "Alpha" }))
    const b = await createLabel(
      jsonReq("http://test/api/labels", { name: "Beta" })
    )
    const bData = (await b.json()) as { id: number }

    const out = await patchLabel(
      jsonReq(`http://test/api/labels/${bData.id}`, { name: "alpha" }, "PATCH"),
      { params: Promise.resolve({ id: String(bData.id) }) }
    )
    expect(out.status).toBe(409)
  })

  it("maps a unique-constraint violation on rename to 409", async () => {
    const created = await createLabel(
      jsonReq("http://test/api/labels", { name: "Alpha" })
    )
    const { id } = (await created.json()) as { id: number }
    // simulate the concurrent-write window: the advisory pre-check passes,
    // then the UPDATE itself hits the unique index (as a racing rename or
    // manual create would). The trigger reproduces the exact violation
    // message better-sqlite3 raises on a real constraint failure.
    db.run(
      `CREATE TRIGGER simulate_rename_race BEFORE UPDATE ON categories
       WHEN NEW.name_key = 'alpha'
       BEGIN
         SELECT RAISE(ABORT, 'UNIQUE constraint failed: categories.name_key');
       END`
    )

    const out = await patchLabel(
      jsonReq(`http://test/api/labels/${id}`, { name: "Alpha" }, "PATCH"),
      { params: Promise.resolve({ id: String(id) }) }
    )
    expect(out.status).toBe(409)
  })

  it("returns 404 for unknown labels", async () => {
    const out = await patchLabel(
      jsonReq("http://test/api/labels/999", { name: "X" }, "PATCH"),
      {
        params: Promise.resolve({ id: "999" }),
      }
    )
    expect(out.status).toBe(404)
  })
})

describe("DELETE /api/labels/[id]", () => {
  it("resets transactions, cascades rules and deletes the label", async () => {
    const created = await createLabel(
      jsonReq("http://test/api/labels", { name: "Miete" })
    )
    const { id } = (await created.json()) as { id: number }
    const txId = seedTx({ labelStatus: "labeled" })
    db.update(transactions)
      .set({ categoryId: id })
      .where(eq(transactions.id, txId))
      .run()
    db.insert(labelRules)
      .values({
        labelId: id,
        iban: IBAN,
        nameKey: "vermieter",
        name: "Vermieter",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run()

    const out = await deleteLabel(
      new NextRequest(
        new Request(`http://x/api/labels/${id}`, { method: "DELETE" })
      ),
      { params: Promise.resolve({ id: String(id) }) }
    )
    expect(out.status).toBe(200)
    const data = (await out.json()) as { affected: number }
    expect(data.affected).toBe(1)

    expect(db.select().from(categories).all()).toHaveLength(0)
    expect(db.select().from(labelRules).all()).toHaveLength(0)
    const row = getTx(txId)!
    expect(row.categoryId).toBeNull()
    expect(row.labelStatus).toBe("pending")
    expect(row.labelAttempts).toBe(0)
  })

  it("returns 404 for unknown ids", async () => {
    const out = await deleteLabel(
      new NextRequest(
        new Request("http://x/api/labels/999", { method: "DELETE" })
      ),
      { params: Promise.resolve({ id: "999" }) }
    )
    expect(out.status).toBe(404)
  })
})

describe("POST /api/transactions/[id]/label", () => {
  it("assigns an existing label, learns the rule and flips origin", async () => {
    const created = await createLabel(
      jsonReq("http://test/api/labels", { name: "Miete" })
    )
    const { id: labelId } = (await created.json()) as { id: number }
    const txId = seedTx({ counterpartyIban: " de02 1203 0000 0000 2020 51 " })

    const out = await assignLabel(
      jsonReq(`http://test/api/transactions/${txId}/label`, { labelId }),
      { params: Promise.resolve({ id: txId }) }
    )
    expect(out.status).toBe(200)

    const row = getTx(txId)!
    expect(row.categoryId).toBe(labelId)
    expect(row.labelStatus).toBe("labeled")
    expect(row.labelAttempts).toBe(0)

    const cat = db.select().from(categories).all()[0]
    expect(cat.origin).toBe("manual")
    expect(cat.usageCount).toBe(1)

    const rules = db.select().from(labelRules).all()
    expect(rules).toHaveLength(1)
    expect(rules[0].iban).toBe(IBAN)
    expect(rules[0].nameKey).toBe("vermieter")
  })

  it("creates a new label inline via labelName", async () => {
    const txId = seedTx()
    const out = await assignLabel(
      jsonReq(`http://test/api/transactions/${txId}/label`, {
        labelName: "Sonstiges",
      }),
      { params: Promise.resolve({ id: txId }) }
    )
    expect(out.status).toBe(200)
    const cat = db.select().from(categories).all()[0]
    expect(cat.name).toBe("Sonstiges")
    expect(cat.origin).toBe("manual")
  })

  it("rejects labelName over 64 UTF-8 bytes with 400", async () => {
    const txId = seedTx()
    const out = await assignLabel(
      jsonReq(`http://test/api/transactions/${txId}/label`, {
        labelName: "ä".repeat(64),
      }),
      { params: Promise.resolve({ id: txId }) }
    )
    expect(out.status).toBe(400)
  })

  it("returns 404 for unknown transactions and labels", async () => {
    const out = await assignLabel(
      jsonReq("http://test/api/transactions/missing/label", { labelName: "X" }),
      { params: Promise.resolve({ id: "missing" }) }
    )
    expect(out.status).toBe(404)

    const txId = seedTx()
    const out2 = await assignLabel(
      jsonReq(`http://test/api/transactions/${txId}/label`, { labelId: 999 }),
      { params: Promise.resolve({ id: txId }) }
    )
    expect(out2.status).toBe(404)
  })
})

describe("DELETE /api/label-rules/[id]", () => {
  it("removes a learned rule", async () => {
    const catId = db
      .insert(categories)
      .values({ name: "A", nameKey: "a", language: "de" })
      .returning()
      .get().id
    const ruleId = db
      .insert(labelRules)
      .values({
        labelId: catId,
        iban: IBAN,
        nameKey: "x",
        name: "X",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .returning()
      .get().id

    const out = await deleteRule(
      new NextRequest(
        new Request(`http://x/api/label-rules/${ruleId}`, { method: "DELETE" })
      ),
      { params: Promise.resolve({ id: String(ruleId) }) }
    )
    expect(out.status).toBe(200)
    expect(db.select().from(labelRules).all()).toHaveLength(0)
  })

  it("returns 404 for unknown rules", async () => {
    const out = await deleteRule(
      new NextRequest(
        new Request("http://x/api/label-rules/999", { method: "DELETE" })
      ),
      { params: Promise.resolve({ id: "999" }) }
    )
    expect(out.status).toBe(404)
  })
})
