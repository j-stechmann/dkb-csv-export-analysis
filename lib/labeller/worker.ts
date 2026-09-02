import { and, eq, inArray, lt, sql } from "drizzle-orm"
import { getConfig } from "@/lib/config"
import { getDb } from "@/lib/db"
import { transactions } from "@/lib/db/schema"
import {
  LabellerClient,
  labelWithChunking,
  type LabellerInput,
} from "@/lib/labeller/client"
import {
  applyLabelResults,
  completeDrainedBatches,
  markRowsFailed,
} from "@/lib/labeller/service"

type WorkerState = { ticking: boolean }

const globalRef = globalThis as unknown as {
  __dkbLabellerWorker?: WorkerState
}

function workerState(): WorkerState {
  if (!globalRef.__dkbLabellerWorker) {
    globalRef.__dkbLabellerWorker = { ticking: false }
  }
  return globalRef.__dkbLabellerWorker
}

export function isWorkerTicking(): boolean {
  return workerState().ticking
}

export interface ClaimedRow {
  id: string
  amountCents: number
  payer: string | null
  payee: string | null
  purpose: string | null
  bookingDate: string
  type: string
}

/**
 * Claim rows for labeling: flips nothing — the claimed rows keep their
 * pending/failed status until results are written. Incrementing
 * label_attempts at claim time makes crashes between claim and write safe:
 * the row is retried next tick until the attempts cap.
 */
export function claimLabelRows(batchSize: number, maxAttempts: number) {
  const db = getDb()
  return db
    .update(transactions)
    .set({
      labelAttempts: sql`${transactions.labelAttempts} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(
      inArray(
        transactions.id,
        db
          .select({ id: transactions.id })
          .from(transactions)
          .where(
            and(
              inArray(transactions.labelStatus, ["pending", "failed"]),
              eq(transactions.status, "Gebucht"),
              lt(transactions.labelAttempts, maxAttempts)
            )
          )
          .orderBy(transactions.id)
          .limit(batchSize)
      )
    )
    .returning()
    .all()
}

function toLabellerInput(row: ClaimedRow): LabellerInput {
  return {
    id: row.id,
    amountCents: row.amountCents,
    counterparty:
      row.type === "Ausgang" ? (row.payee ?? "") : (row.payer ?? ""),
    purpose: row.purpose ?? "",
    bookingDate: row.bookingDate,
  }
}

/**
 * One worker pass: claim a batch of rows, label them, persist results.
 * Errors are contained per pass — a failing chunk marks its rows failed
 * (attempts already incremented) and never kills the worker loop.
 */
export async function tick(): Promise<void> {
  const state = workerState()
  if (state.ticking) return
  state.ticking = true
  try {
    const importState = globalThis as unknown as {
      __dkbImportJob?: { running: boolean }
    }
    if (importState.__dkbImportJob?.running) return

    const cfg = getConfig()

    // drain check first: completing a batch needs no labeller — only the
    // absence of labelable pending rows (also covers all-Nicht-gebucht
    // batches and rows that exhausted their attempts)
    completeDrainedBatches(cfg.LABELLER_MAX_ATTEMPTS)

    const client = new LabellerClient()
    const health = await client.health()
    if (health !== "ok") return

    const claimed = claimLabelRows(
      cfg.LABELLER_BATCH_SIZE,
      cfg.LABELLER_MAX_ATTEMPTS
    )
    if (claimed.length === 0) return

    try {
      await labelWithChunking(
        client,
        claimed.map(toLabellerInput),
        (results) => {
          applyLabelResults(results)
        }
      )
    } catch (err) {
      console.error("[label worker] chunk failed, marking rows failed:", err)
      markRowsFailed(claimed.map((r) => r.id))
    }

    completeDrainedBatches(cfg.LABELLER_MAX_ATTEMPTS)
  } finally {
    state.ticking = false
  }
}

/** Start the periodic worker loop (idempotent across dev hot-reloads). */
export function startLabelWorker(): void {
  const g = globalThis as unknown as { __dkbLabellerWorkerStarted?: boolean }
  if (g.__dkbLabellerWorkerStarted) return
  g.__dkbLabellerWorkerStarted = true

  const initialTimer = setTimeout(() => {
    void tick()
  }, 3000)
  initialTimer.unref?.()

  const interval = setInterval(() => {
    void tick()
  }, 3000)
  interval.unref?.()
}
