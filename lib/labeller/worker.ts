import { and, eq, inArray, lt, sql } from "drizzle-orm"
import { getConfig } from "@/lib/config"
import { getDb } from "@/lib/db"
import { categories, transactions } from "@/lib/db/schema"
import {
  LlmClient,
  LlmTimeoutError,
  toPromptTransaction,
} from "@/lib/llm/client"
import type { PromptTransaction } from "@/lib/llm/prompt"
import { resolveLabelNames, suggestForBatch } from "@/lib/labels/matching"
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
  counterpartyIban: string | null
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

function counterpartyFor(row: ClaimedRow): string {
  return row.type === "Ausgang" ? (row.payee ?? "") : (row.payer ?? "")
}

/**
 * One worker pass: health gate → claim a batch → resolve rule suggestions →
 * label via llama-server → persist results → mark unapplied rows failed.
 * Errors are contained per pass — a failing call marks its rows failed
 * (attempts already incremented), and any other failure (including the
 * synchronous DB calls) is logged instead of escaping as an unhandled
 * rejection. Never kills the worker loop.
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

    // drain check first: completing a batch needs no LLM — only the
    // absence of labelable pending rows (also covers all-Nicht-gebucht
    // batches and rows that exhausted their attempts)
    completeDrainedBatches(cfg.LLM_MAX_ATTEMPTS)

    const client = new LlmClient()
    // health gate: without it an LLM outage would burn every row's attempt
    // budget on timed-out claims (rows become unclaimable until manual retry)
    const health = await client.health()
    if (health !== "ok") return

    const claimed = claimLabelRows(cfg.LLM_BATCH_SIZE, cfg.LLM_MAX_ATTEMPTS)
    if (claimed.length === 0) return

    // attempts snapshot at claim time: a mismatch at apply time means the
    // row was reset meanwhile (concurrent fuzzy-update, retry endpoint, or
    // manual assignment), so its stale LLM result must not be applied
    const claimedAttempts = new Map(
      claimed.map((r): [string, number] => [r.id, r.labelAttempts])
    )

    // multi-suggestions: all learned rules for each claimed row's IBAN key
    const db = getDb()
    const suggestionMap = suggestForBatch(
      claimed.map((r) => ({ counterpartyIban: r.counterpartyIban }))
    )
    const allSuggestionIds = [...new Set([...suggestionMap.values()].flat())]
    const labelNames = resolveLabelNames(db, allSuggestionIds)

    const items: PromptTransaction[] = claimed.map((row, i) => {
      const ids = suggestionMap.get(i) ?? []
      const suggestions = ids
        .map((id) => labelNames.get(id))
        .filter((x): x is string => x !== undefined)
      return {
        id: row.id,
        amountCents: row.amountCents,
        counterparty: counterpartyFor(row),
        purpose: row.purpose ?? "",
        bookingDate: row.bookingDate,
        suggestions,
      }
    })

    try {
      const results = await client.labelBatch(
        items.map(toPromptTransaction),
        existingLabelsForPrompt(cfg)
      )
      applyLabelResults(results, claimedAttempts)
      // no fallback labels: claimed rows with no applied result (empty or
      // partial model output) are explicitly failed — they keep their
      // incremented attempts and show as "ohne Kategorie" until retried
      const appliedIds = new Set(results.map((r) => r.id))
      const unapplied = claimed
        .map((r) => r.id)
        .filter((id) => !appliedIds.has(id))
      markRowsFailed(unapplied, claimedAttempts)
    } catch (err) {
      if (err instanceof LlmTimeoutError) {
        console.error("[label worker] LLM timeout, marking rows failed")
      } else {
        console.error("[label worker] chunk failed, marking rows failed:", err)
      }
      markRowsFailed(
        claimed.map((r) => r.id),
        claimedAttempts
      )
    }

    completeDrainedBatches(cfg.LLM_MAX_ATTEMPTS)
  } catch (err) {
    console.error("[label worker] tick failed:", err)
  } finally {
    state.ticking = false
  }
}

/**
 * Existing labels for the system prompt: most-used first, capped. Read
 * synchronously from the DB (the prompt builder handles the empty case).
 */
function existingLabelsForPrompt(cfg: ReturnType<typeof getConfig>): string[] {
  if (cfg.LLM_MAX_LABELS_PROMPT === 0) return []
  const db = getDb()
  const rows = db
    .select({ name: categories.name })
    .from(categories)
    .orderBy(sql`usage_count DESC, name ASC`)
    .limit(cfg.LLM_MAX_LABELS_PROMPT)
    .all()
  return rows.map((r) => r.name)
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
