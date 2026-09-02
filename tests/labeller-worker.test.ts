import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { eq } from "drizzle-orm"
import { createTestDb, setTestDb, type Db } from "@/lib/db"
import { accounts, importBatches, transactions } from "@/lib/db/schema"
import { claimLabelRows, tick } from "@/lib/labeller/worker"
import { computeLabelCounters } from "@/lib/import/counters"
import { resetFailedLabels } from "@/lib/import/pipeline"
import { getConfig } from "@/lib/config"

const ACC_IBAN = "DE02120300000000202051"
const ACC_NAME = "Girokonto"

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
    status: string
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
      payee: "REWE",
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
    .values({ iban: ACC_IBAN, name: ACC_NAME })
    .returning()
    .get().id
})

describe("claimLabelRows", () => {
  it("claims pending Gebucht rows and increments attempts", () => {
    const batchId = seedBatch()
    const id = seedTx(batchId)

    const claimed = claimLabelRows(10, 5)

    expect(claimed).toHaveLength(1)
    expect(claimed[0].id).toBe(id)
    expect(claimed[0].labelAttempts).toBe(1)
    // status untouched until results are written (crash-safe)
    expect(getTx(id)!.labelStatus).toBe("pending")
  })

  it("never claims non-Gebucht rows", () => {
    const batchId = seedBatch()
    seedTx(batchId, { status: "Nicht gebucht" })

    expect(claimLabelRows(10, 5)).toHaveLength(0)
  })

  it("respects the attempts cap", () => {
    const batchId = seedBatch()
    seedTx(batchId, { labelStatus: "failed", labelAttempts: 5 })

    expect(claimLabelRows(10, 5)).toHaveLength(0)
  })

  it("claims failed rows below the cap", () => {
    const batchId = seedBatch()
    const id = seedTx(batchId, { labelStatus: "failed", labelAttempts: 4 })

    const claimed = claimLabelRows(10, 5)
    expect(claimed).toHaveLength(1)
    expect(claimed[0].id).toBe(id)
  })
})

function stubFetch(handler: (url: string, body: unknown) => Response) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    return handler(url, body)
  })
}

describe("tick", () => {
  afterEach(() => vi.restoreAllMocks())

  it("marks rows failed when the labeller errors and completes the batch", async () => {
    const batchId = seedBatch()
    const id = seedTx(batchId)
    const cfg = getConfig()

    vi.stubGlobal(
      "fetch",
      stubFetch((url) =>
        url.includes("/v1/health")
          ? new Response("{}", { status: 200 })
          : new Response("{}", { status: 503 })
      )
    )

    await tick()

    const row = getTx(id)!
    expect(row.labelStatus).toBe("failed")
    expect(row.labelAttempts).toBe(1)

    const batch = getBatch(batchId)!
    // drained: failed rows don't block completion
    expect(batch.status).toBe("completed")
    expect(batch.completedAt).not.toBeNull()

    const counters = computeLabelCounters(batchId)
    expect(counters).toEqual({ labelsTotal: 1, labelsDone: 0, labelsFailed: 1 })
    expect(cfg.LABELLER_MAX_ATTEMPTS).toBeGreaterThan(0)
  })

  it("labels rows and completes the batch on success", async () => {
    const batchId = seedBatch()
    const id = seedTx(batchId)

    vi.stubGlobal(
      "fetch",
      stubFetch((url, body) => {
        if (url.includes("/v1/health")) {
          return new Response("{}", { status: 200 })
        }
        const b = body as { transactions: Array<{ id: string }> }
        return new Response(
          JSON.stringify({
            results: b.transactions.map((t) => ({
              id: t.id,
              label: "Lebensmittel",
            })),
          }),
          { status: 200 }
        )
      })
    )

    await tick()

    const row = getTx(id)!
    expect(row.labelStatus).toBe("labeled")
    expect(row.categoryId).not.toBeNull()

    const batch = getBatch(batchId)!
    expect(batch.status).toBe("completed")
    expect(computeLabelCounters(batchId)).toEqual({
      labelsTotal: 1,
      labelsDone: 1,
      labelsFailed: 0,
    })
  })

  it("does not complete a batch with rows still pending", async () => {
    const batchId = seedBatch()
    seedTx(batchId)
    // a second pending row beyond the claim batch size
    seedTx(batchId)

    vi.stubGlobal(
      "fetch",
      stubFetch((url, body) => {
        if (url.includes("/v1/health")) {
          return new Response("{}", { status: 200 })
        }
        const b = body as { transactions: Array<{ id: string }> }
        return new Response(
          JSON.stringify({
            results: b.transactions.map((t) => ({
              id: t.id,
              label: "Miete",
            })),
          }),
          { status: 200 }
        )
      })
    )

    // batch size 1 via env: the worker claims only the first pending row,
    // leaving the second pending → batch must stay 'labeling'
    process.env.LABELLER_BATCH_SIZE = "1"
    const { resetConfigCache } = await import("@/lib/config")
    resetConfigCache()

    try {
      await tick()
      const batch = getBatch(batchId)!
      expect(batch.status).toBe("labeling")
      expect(computeLabelCounters(batchId)).toEqual({
        labelsTotal: 2,
        labelsDone: 1,
        labelsFailed: 0,
      })
    } finally {
      process.env.LABELLER_BATCH_SIZE = "100"
      resetConfigCache()
    }
  })

  it("completes a batch whose rows are all Nicht gebucht", async () => {
    const batchId = seedBatch()
    seedTx(batchId, { status: "Nicht gebucht" })

    // health check fails but drain completion must run regardless
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED")
      })
    )

    await tick()

    expect(getBatch(batchId)!.status).toBe("completed")
  })
})

describe("retry requeue", () => {
  it("resetFailedLabels resets failed rows below the cap", () => {
    const batchId = seedBatch()
    const ok = seedTx(batchId, { labelStatus: "failed", labelAttempts: 2 })
    seedTx(batchId, { labelStatus: "failed", labelAttempts: 9 })

    const queued = resetFailedLabels(5)

    expect(queued).toBe(1)
    expect(getTx(ok)!.labelStatus).toBe("pending")
  })

  it("resetFailedLabels ignores pending rows", () => {
    const batchId = seedBatch()
    seedTx(batchId, { labelStatus: "pending" })

    expect(resetFailedLabels(5)).toBe(0)
  })
})

describe("computeLabelCounters", () => {
  it("counts only Gebucht rows and partitions by labelStatus", () => {
    const batchId = seedBatch()
    seedTx(batchId)
    seedTx(batchId, { labelStatus: "failed" })
    seedTx(batchId, { status: "Nicht gebucht" })

    expect(computeLabelCounters(batchId)).toEqual({
      labelsTotal: 2,
      labelsDone: 0,
      labelsFailed: 1,
    })
  })
})
