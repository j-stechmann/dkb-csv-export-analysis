import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { eq } from "drizzle-orm"
import type { Db } from "@/lib/db"
import {
  accounts,
  categories,
  importBatches,
  labelRules,
  transactions,
  users,
} from "@/lib/db/schema"
import { claimLabelRows, isWorkerTicking, tick } from "@/lib/labeller/worker"
import { computeLabelCounters } from "@/lib/import/counters"
import { applyLabelResults, markRowsFailed } from "@/lib/labeller/service"
import { resetFailedLabels } from "@/lib/import/pipeline"
import { getConfig, resetConfigCache } from "@/lib/config"
import { resetWorkerConfigFailureForTest } from "@/lib/labeller/worker"
import { setupTestDb } from "./helpers"

const ACC_IBAN = "DE02120300000000202051"
const ACC_NAME = "Girokonto"

let db: Db
let userId: number
let accountId: number
let batchCounter = 0

function seedBatch(status = "labeling"): string {
  batchCounter++
  const id = `b${batchCounter}`
  db.insert(importBatches)
    .values({ id, userId, fileName: `${id}.csv`, accountId, status })
    .run()
  return id
}

function seedTx(
  batchId: string,
  overrides: Partial<{
    labelStatus: string
    labelAttempts: number
    status: string
    payer: string | null
    payee: string | null
    counterpartyIban: string | null
  }> = {}
): string {
  const id = `tx-${crypto.randomUUID()}`
  db.insert(transactions)
    .values({
      id,
      userId,
      accountId,
      batchId,
      bookingDate: "2026-02-03",
      status: "Gebucht",
      payer: "Max Mustermann",
      payee: "REWE",
      type: "Ausgang",
      counterpartyIban: "DE02120300000000202051",
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
  ;({ db, userId } = setupTestDb())
  accountId = db
    .insert(accounts)
    .values({ userId, iban: ACC_IBAN, name: ACC_NAME })
    .returning()
    .get().id
  resetWorkerConfigFailureForTest()
  resetConfigCache()
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

/**
 * Stub for the llama-server chat protocol: answers /health with 200 and the
 * chat completion with one label per message position.
 */
function stubLlmFetch(label: string | null) {
  return stubFetch((url, body) => {
    if (url.includes("/health") && !url.includes("chat")) {
      return new Response("{}", { status: 200 })
    }
    if (url.includes("/v1/chat/completions")) {
      if (label === null) {
        return new Response("{}", { status: 503 })
      }
      const b = body as {
        messages: Array<{ role: string; content: string }>
      }
      const userMsg = b.messages.find((m) => m.role === "user")!
      const count = (userMsg.content.match(/^\[\d+\]/gm) ?? []).length
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  results: Array.from({ length: count }, (_, i) => ({
                    index: i,
                    label,
                  })),
                }),
              },
            },
          ],
        }),
        { status: 200 }
      )
    }
    return new Response("{}", { status: 404 })
  })
}

describe("tick", () => {
  afterEach(() => vi.restoreAllMocks())

  it("marks rows failed when the LLM errors and completes the batch", async () => {
    const batchId = seedBatch()
    const id = seedTx(batchId)
    const cfg = getConfig()

    vi.stubGlobal("fetch", stubLlmFetch(null))

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
    expect(cfg.LLM_MAX_ATTEMPTS).toBeGreaterThan(0)
  })

  it("labels rows and completes the batch on success", async () => {
    const batchId = seedBatch()
    const id = seedTx(batchId)

    vi.stubGlobal("fetch", stubLlmFetch("Lebensmittel"))

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

  it("suggests labels from learned rules and prefers them in the prompt", async () => {
    const batchId = seedBatch()
    const id = seedTx(batchId, {
      payer: "Max Mustermann",
      payee: "REWE",
      counterpartyIban: "DE02120300000000202051",
    })

    // learn a rule for this exact (payer, payee, IBAN) triple
    const cat = db
      .insert(categories)
      .values({
        userId,
        name: "Miete",
        nameKey: "miete",
        language: "de",
        origin: "manual",
      })
      .returning()
      .get()
    db.insert(labelRules)
      .values({
        userId,
        labelId: cat.id,
        payer: "Max Mustermann",
        payee: "REWE",
        counterpartyIban: "DE02120300000000202051",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run()

    let promptSuggestion: string | null = null
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/health") && !url.includes("chat")) {
        return new Response("{}", { status: 200 })
      }
      const b = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>
      }
      const userMsg = b.messages.find((m) => m.role === "user")!
      const match = userMsg.content.match(/suggested_labels=<<([^>]*)>>/)
      promptSuggestion = match ? match[1] : null
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  results: [{ index: 0, label: "Miete" }],
                }),
              },
            },
          ],
        }),
        { status: 200 }
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    await tick()

    expect(promptSuggestion).toBe("Miete")
    const row = getTx(id)!
    expect(row.labelStatus).toBe("labeled")
    expect(row.categoryId).toBe(cat.id)
  })

  it("issues one LLM call per user with only that user's label vocabulary", async () => {
    // a second user in the same claim batch
    const otherUser = db
      .insert(users)
      .values({
        issuer: "https://issuer.example.com",
        subject: "worker-user-2",
        name: "Worker User 2",
        email: "worker-user-2@example.com",
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get().id
    const otherAccountId = db
      .insert(accounts)
      .values({
        userId: otherUser,
        iban: "DE03999999990000001234",
        name: "Konto B",
      })
      .returning()
      .get().id
    const batchId = seedBatch()
    const otherBatchId = seedBatch()
    // user A's pending row: account/batch belong to A
    db.update(importBatches)
      .set({ userId: otherUser, accountId: otherAccountId })
      .where(eq(importBatches.id, otherBatchId))
      .run()
    const otherTxId = `tx-${crypto.randomUUID()}`
    db.insert(transactions)
      .values({
        id: otherTxId,
        userId: otherUser,
        accountId: otherAccountId,
        batchId: otherBatchId,
        bookingDate: "2026-02-03",
        status: "Gebucht",
        payer: "Max Mustermann",
        payee: "REWE",
        type: "Ausgang",
        counterpartyIban: "DE02120300000000202051",
        amountCents: -100,
        sourceHash: `hash-${otherTxId}`,
        labelStatus: "pending",
        labelAttempts: 0,
      })
      .run()
    seedTx(batchId)

    // each user's vocabulary: A has "Miete", B has "Ausland"
    db.insert(categories)
      .values({
        userId,
        name: "Miete",
        nameKey: "miete",
        language: "de",
      })
      .run()
    db.insert(categories)
      .values({
        userId: otherUser,
        name: "Ausland",
        nameKey: "ausland",
        language: "de",
      })
      .run()

    const seenSystemPrompts: string[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/health") && !url.includes("chat")) {
        return new Response("{}", { status: 200 })
      }
      const b = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>
      }
      seenSystemPrompts.push(
        b.messages.find((m) => m.role === "system")!.content
      )
      const userMsg = b.messages.find((m) => m.role === "user")!
      const count = (userMsg.content.match(/^\[\d+\]/gm) ?? []).length
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  results: Array.from({ length: count }, (_, i) => ({
                    index: i,
                    label: "Miete",
                  })),
                }),
              },
            },
          ],
        }),
        { status: 200 }
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    await tick()

    // one chat call per user (plus the health probe)
    expect(seenSystemPrompts).toHaveLength(2)
    // each prompt carries only its owner's vocabulary — no cross-user leak
    for (const prompt of seenSystemPrompts) {
      const hasMiete = prompt.includes("Miete")
      const hasAusland = prompt.includes("Ausland")
      expect(hasMiete && hasAusland).toBe(false)
      expect(hasMiete || hasAusland).toBe(true)
    }
    expect(seenSystemPrompts.filter((p) => p.includes("Miete"))).toHaveLength(1)
    expect(seenSystemPrompts.filter((p) => p.includes("Ausland"))).toHaveLength(
      1
    )
  })

  it("contains one user's LLM failure — the other user's rows still label", async () => {
    const otherUser = db
      .insert(users)
      .values({
        issuer: "https://issuer.example.com",
        subject: "worker-user-3",
        name: "Worker User 3",
        email: "worker-user-3@example.com",
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get().id
    const otherAccountId = db
      .insert(accounts)
      .values({
        userId: otherUser,
        iban: "DE04999999990000001234",
        name: "Konto C",
      })
      .returning()
      .get().id
    const batchId = seedBatch()
    const otherBatchId = seedBatch()
    db.update(importBatches)
      .set({ userId: otherUser, accountId: otherAccountId })
      .where(eq(importBatches.id, otherBatchId))
      .run()
    const otherTxId = `tx-${crypto.randomUUID()}`
    db.insert(transactions)
      .values({
        id: otherTxId,
        userId: otherUser,
        accountId: otherAccountId,
        batchId: otherBatchId,
        bookingDate: "2026-02-03",
        status: "Gebucht",
        payer: "Max Mustermann",
        payee: "REWE",
        type: "Ausgang",
        counterpartyIban: "DE02120300000000202051",
        amountCents: -100,
        sourceHash: `hash-${otherTxId}`,
        labelStatus: "pending",
        labelAttempts: 0,
      })
      .run()
    const aTxId = seedTx(batchId)

    // user A's vocabulary so their chunk is identifiable by prompt content
    db.insert(categories)
      .values({
        userId,
        name: "Miete",
        nameKey: "miete",
        language: "de",
      })
      .run()

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    // user A owns the "Miete" vocabulary; their chunk gets the 503.
    // user B has no labels in the prompt — their chunk succeeds.
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/health") && !url.includes("chat")) {
        return new Response("{}", { status: 200 })
      }
      const b = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>
      }
      const systemMsg = b.messages.find((m) => m.role === "system")!.content
      if (systemMsg.includes("Miete")) {
        return new Response("{}", { status: 503 })
      }
      const userMsg = b.messages.find((m) => m.role === "user")!
      const count = (userMsg.content.match(/^\[\d+\]/gm) ?? []).length
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  results: Array.from({ length: count }, (_, i) => ({
                    index: i,
                    label: "Lebensmittel",
                  })),
                }),
              },
            },
          ],
        }),
        { status: 200 }
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    await tick()

    // user A's row: failed (its chunk errored)
    expect(getTx(aTxId)!.labelStatus).toBe("failed")
    // user B's row: labeled (its chunk succeeded — not collateral damage)
    expect(getTx(otherTxId)!.labelStatus).toBe("labeled")
    // only the failing user's chunk was logged
    expect(errSpy).toHaveBeenCalledTimes(1)
  })

  it("marks unapplied rows failed on partial model output", async () => {
    const batchId = seedBatch()
    const id = seedTx(batchId)

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/health") && !url.includes("chat")) {
        return new Response("{}", { status: 200 })
      }
      // valid JSON but empty results — nothing gets applied
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ results: [] }),
              },
            },
          ],
        }),
        { status: 200 }
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    await tick()

    const row = getTx(id)!
    expect(row.labelStatus).toBe("failed")
    expect(row.categoryId).toBeNull()
  })

  it("does not complete a batch with rows still pending", async () => {
    const batchId = seedBatch()
    seedTx(batchId)
    // a second pending row beyond the claim batch size
    seedTx(batchId)

    vi.stubGlobal("fetch", stubLlmFetch("Miete"))

    // batch size 1 via env: the worker claims only the first pending row,
    // leaving the second pending → batch must stay 'labeling'
    process.env.LLM_BATCH_SIZE = "1"
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
      process.env.LLM_BATCH_SIZE = "100"
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

  it("contains a sync DB error instead of rejecting", async () => {
    const batchId = seedBatch()
    seedTx(batchId)

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    // make the first sync DB write throw (e.g. SQLITE_BUSY past timeout)
    vi.spyOn(db, "update").mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY: database is locked")
    })

    await expect(tick()).resolves.toBeUndefined()

    expect(errSpy).toHaveBeenCalledWith(
      "[label worker] tick failed:",
      expect.any(Error)
    )
    expect(isWorkerTicking()).toBe(false)
  })
})

describe("applyLabelResults", () => {
  it("applies labels only to rows untouched since claim", () => {
    const batchId = seedBatch()
    const stableId = seedTx(batchId)
    const resetId = seedTx(batchId)

    // claim one batch (attempts → 1), then simulate a concurrent reset of
    // one row (fuzzy-update / retry) before results arrive
    const claimed = claimLabelRows(10, 5)
    expect(claimed).toHaveLength(2)
    db.update(transactions)
      .set({ labelStatus: "pending", labelAttempts: 0 })
      .where(eq(transactions.id, resetId))
      .run()

    const claimedAttempts = new Map(
      claimed.map((r): [string, number] => [r.id, r.labelAttempts])
    )
    applyLabelResults(
      [stableId, resetId].map((id) => ({ id, label: "Lebensmittel" })),
      claimedAttempts
    )

    expect(getTx(stableId)!.labelStatus).toBe("labeled")
    expect(getTx(resetId)!.labelStatus).toBe("pending")
    expect(getTx(resetId)!.labelAttempts).toBe(0)
  })
})

describe("markRowsFailed", () => {
  it("marks claimed rows failed and skips already-labeled ones", () => {
    const batchId = seedBatch()
    const failedId = seedTx(batchId)
    const labeledId = seedTx(batchId)

    const claimed = claimLabelRows(10, 5)
    expect(claimed).toHaveLength(2)
    db.update(transactions)
      .set({ labelStatus: "labeled" })
      .where(eq(transactions.id, labeledId))
      .run()

    const claimedAttempts = new Map(
      claimed.map((r): [string, number] => [r.id, r.labelAttempts])
    )
    markRowsFailed([failedId, labeledId], claimedAttempts)

    expect(getTx(failedId)!.labelStatus).toBe("failed")
    expect(getTx(failedId)!.labelAttempts).toBe(1)
    expect(getTx(labeledId)!.labelStatus).toBe("labeled")
  })

  it("leaves rows untouched that were reset since claim", () => {
    const batchId = seedBatch()
    const resetId = seedTx(batchId)

    const claimed = claimLabelRows(10, 5)
    expect(claimed).toHaveLength(1)
    // concurrent fuzzy-update / retry reset the row before the chunk failed
    db.update(transactions)
      .set({ labelStatus: "pending", labelAttempts: 0 })
      .where(eq(transactions.id, resetId))
      .run()

    const claimedAttempts = new Map(
      claimed.map((r): [string, number] => [r.id, r.labelAttempts])
    )
    markRowsFailed([resetId], claimedAttempts)

    expect(getTx(resetId)!.labelStatus).toBe("pending")
    expect(getTx(resetId)!.labelAttempts).toBe(0)
  })
})

describe("retry requeue", () => {
  it("resetFailedLabels revives rows that exhausted their attempts", () => {
    const batchId = seedBatch()
    const capped = seedTx(batchId, { labelStatus: "failed", labelAttempts: 5 })
    const cappedPending = seedTx(batchId, {
      labelStatus: "pending",
      labelAttempts: 6,
    })
    // below the cap: worker self-heals these, retry leaves them alone
    seedTx(batchId, { labelStatus: "failed", labelAttempts: 2 })

    const queued = resetFailedLabels(5, userId)

    expect(queued).toBe(2)
    expect(getTx(capped)!.labelStatus).toBe("pending")
    expect(getTx(capped)!.labelAttempts).toBe(0)
    expect(getTx(cappedPending)!.labelStatus).toBe("pending")
    expect(getTx(cappedPending)!.labelAttempts).toBe(0)
  })

  it("resetFailedLabels ignores rows below the cap", () => {
    const batchId = seedBatch()
    const belowCap = seedTx(batchId, {
      labelStatus: "failed",
      labelAttempts: 2,
    })

    expect(resetFailedLabels(5, userId)).toBe(0)
    expect(getTx(belowCap)!.labelStatus).toBe("failed")
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
