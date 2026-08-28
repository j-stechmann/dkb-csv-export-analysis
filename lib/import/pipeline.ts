import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { eq, inArray, sql } from "drizzle-orm"
import { getDb } from "@/lib/db"
import {
  accounts,
  importBatches,
  transactions,
} from "@/lib/db/schema"
import {
  parseDkbCsv,
  peekDkbCsvAccount,
  CsvParseError,
} from "@/lib/csv/parser"
import { computeDedupe, hashTransaction, HASH_VERSION } from "@/lib/db/dedupe"
import { runLabeling, pruneOrphanCategories } from "@/lib/labeller/service"

export type ImportStage =
  | "parsing"
  | "importing"
  | "labeling"
  | "completed"
  | "failed"

export interface StartImportResult {
  batchId: string
}

export class ImportInProgressError extends Error {
  constructor() {
    super("another import is already in progress")
    this.name = "ImportInProgressError"
  }
}

type JobState = {
  running: boolean
  currentBatchId: string | null
}

const globalRef = globalThis as unknown as {
  __dkbImportJob?: JobState
}

function jobState(): JobState {
  if (!globalRef.__dkbImportJob) {
    globalRef.__dkbImportJob = { running: false, currentBatchId: null }
  }
  return globalRef.__dkbImportJob
}

export function isImportRunning(): boolean {
  return jobState().running
}

export function currentBatchId(): string | null {
  return jobState().currentBatchId
}

/** Peek account info synchronously — no DB writes on failure. */
export function peekAccount(csvContent: string) {
  return peekDkbCsvAccount(csvContent)
}

/**
 * Persist the uploaded file to a temp location and kick the background job.
 * The account/batch rows are created inside the job (after full parse) so
 * a parse failure leaves no orphan rows.
 */
export function startImport(
  fileName: string,
  csvContent: string
): StartImportResult {
  const state = jobState()
  if (state.running) {
    throw new ImportInProgressError()
  }

  const batchId = crypto.randomUUID()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dkb-import-"))
  const tmpFile = path.join(tmpDir, "upload.csv")
  fs.writeFileSync(tmpFile, csvContent, "utf8")

  // fire-and-forget with full error containment
  void runImportJob(batchId, fileName, tmpFile, tmpDir).catch((err) => {
    console.error(`[import] unhandled job error batch=${batchId}:`, err)
  })

  state.running = true
  state.currentBatchId = batchId
  return { batchId }
}

async function runImportJob(
  batchId: string,
  fileName: string,
  tmpFile: string,
  tmpDir: string
): Promise<void> {
  const state = jobState()
  const db = getDb()
  try {
    // ── stage: parsing ──────────────────────────────────────────────
    db.insert(importBatches)
      .values({ id: batchId, fileName, status: "parsing" })
      .run()

    const content = fs.readFileSync(tmpFile, "utf8")
    let parsed
    try {
      parsed = parseDkbCsv(content)
    } catch (err) {
      const message =
        err instanceof CsvParseError
          ? err.message
          : `parse failed: ${(err as Error).message}`
      db.update(importBatches)
        .set({
          status: "failed",
          error: message,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(importBatches.id, batchId))
        .run()
      return
    }

    // ── account upsert (after successful parse → no orphans) ───────
    let account = db
      .select()
      .from(accounts)
      .where(eq(accounts.iban, parsed.accountIban))
      .get()
    if (!account) {
      const inserted = db
        .insert(accounts)
        .values({ iban: parsed.accountIban, name: parsed.accountName })
        .onConflictDoNothing()
        .returning()
        .get()
      account = inserted ?? db
        .select()
        .from(accounts)
        .where(eq(accounts.iban, parsed.accountIban))
        .get()
    }
    if (!account) {
      throw new Error(`could not resolve account ${parsed.accountIban}`)
    }

    db.update(importBatches)
      .set({
        accountId: account.id,
        snapshotDate: parsed.snapshotDate,
        snapshotAmountCents: parsed.snapshotAmountCents,
        rowsTotal: parsed.rows.length,
        status: "importing",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(importBatches.id, batchId))
      .run()

    // ── stage: dedupe + insert ──────────────────────────────────────
    const existingRows = db
      .select({
        sourceHash: transactions.sourceHash,
        occurrenceIndex: transactions.occurrenceIndex,
      })
      .from(transactions)
      .where(eq(transactions.accountId, account.id))
      .all()

    const existingByHash = new Map<string, Set<number>>()
    for (const r of existingRows) {
      if (r.sourceHash && typeof r.occurrenceIndex === "number") {
        let set = existingByHash.get(r.sourceHash)
        if (!set) {
          set = new Set()
          existingByHash.set(r.sourceHash, set)
        }
        set.add(r.occurrenceIndex)
      }
    }

    const dedupe = computeDedupe(
      parsed.accountIban,
      account.id,
      batchId,
      parsed.rows,
      existingByHash
    )

    const insertedCount = db.transaction((tx) => {
      let count = 0
      for (const row of dedupe.toInsert) {
        tx.insert(transactions)
          .values(row)
          .onConflictDoNothing({
            target: [
              transactions.accountId,
              transactions.sourceHash,
              transactions.occurrenceIndex,
            ],
          })
          .run()
        count++
      }
      return count
    })

    // invariant check: imported + duplicates === total
    const totalInDb = db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(eq(transactions.batchId, batchId))
      .get()
    const imported = totalInDb?.count ?? 0
    if (imported + dedupe.duplicateCount !== dedupe.totalRows) {
      throw new Error(
        `dedupe invariant violated: imported(${imported}) + duplicates(${dedupe.duplicateCount}) !== total(${dedupe.totalRows})`
      )
    }

    db.update(importBatches)
      .set({
        rowsImported: imported,
        rowsDuplicate: dedupe.duplicateCount,
        labelsTotal: imported,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(importBatches.id, batchId))
      .run()

    // ── stage: labeling ─────────────────────────────────────────────
    db.update(importBatches)
      .set({ status: "labeling", updatedAt: new Date().toISOString() })
      .where(eq(importBatches.id, batchId))
      .run()

    const summary = await runLabeling(["pending", "failed"])

    const failedLabels = db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(
        sql`${transactions.batchId} = ${batchId} AND ${transactions.labelStatus} = 'failed'`
      )
      .get()

    db.update(importBatches)
      .set({
        status: "completed",
        labelsDone: summary.labeled,
        labelsFailed: failedLabels?.count ?? 0,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(importBatches.id, batchId))
      .run()

    pruneOrphanCategories()
  } catch (err) {
    db.update(importBatches)
      .set({
        status: "failed",
        error: (err as Error).message,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(importBatches.id, batchId))
      .run()
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
    state.running = false
    state.currentBatchId = null
  }
}

/** Mark batches stuck in non-terminal states as failed (startup recovery). */
export function resetStuckBatches(): number {
  const db = getDb()
  const result = db
    .update(importBatches)
    .set({
      status: "failed",
      error: "interrupted by server restart",
      updatedAt: new Date().toISOString(),
    })
    .where(inArray(importBatches.status, ["parsing", "importing", "labeling"]))
    .returning({ id: importBatches.id })
    .all()
  return result.length
}

/** enqueue relabeling for pending/failed transactions (attempts < cap). */
export function resetFailedLabels(maxAttempts: number): number {
  const db = getDb()
  const result = db
    .update(transactions)
    .set({ labelStatus: "pending", updatedAt: new Date().toISOString() })
    .where(
      sql`${transactions.labelStatus} = 'failed' AND ${transactions.labelAttempts} < ${maxAttempts}`
    )
    .returning({ id: transactions.id })
    .all()
  return result.length
}

export { hashTransaction, HASH_VERSION }