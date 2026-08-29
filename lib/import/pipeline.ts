import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { eq, inArray, sql } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { accounts, importBatches, transactions } from "@/lib/db/schema"
import {
  parseDkbCsv,
  peekDkbCsvAccount,
  CsvParseError,
  type ParsedTransactionRow,
} from "@/lib/csv/parser"
import { computeDedupe, hashTransaction, HASH_VERSION, lowestFreeIndex } from "@/lib/db/dedupe"
import {
  findDbSelfHealPairs,
  matchIncoming,
  toDbMatchRow,
  type DbMatchRow,
} from "@/lib/db/match"
import { runLabeling, pruneOrphanCategories } from "@/lib/labeller/service"

export type ImportStage =
  "parsing" | "importing" | "labeling" | "completed" | "failed"

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
      account =
        inserted ??
        db
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

    // ── stage: fuzzy reconcile + dedupe + insert ─────────────────────
    const {
      imported,
      duplicateCount,
      updatedCount,
      totalRows,
    } = runReconcileAndDedupeStage(
      account.iban,
      account.id,
      batchId,
      parsed.rows
    )

    if (imported + duplicateCount + updatedCount !== totalRows) {
      throw new Error(
        `dedupe invariant violated: imported(${imported}) + duplicates(${duplicateCount}) + updated(${updatedCount}) !== total(${totalRows})`
      )
    }

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

export interface ReconcileStageResult {
  insertedCount: number
  updatedCount: number
  deletedCount: number
  skippedCount: number
  duplicateCount: number
  totalRows: number
  imported: number
}

/**
 * Fuzzy pending→booked reconciliation + occurrence-aware dedupe + insert,
 * all mutations in ONE transaction:
 * 1. self-heal: delete DB pending rows that match a DB booked row
 * 2. classify incoming rows vs DB (upgrades / skip / refresh)
 * 3. exact dedupe tier on unconsumed rows only
 * 4. apply: deletes → in-place updates (fresh hash + occurrence slot) → inserts
 */
export function runReconcileAndDedupeStage(
  accountIban: string,
  accountId: number,
  batchId: string,
  rows: ParsedTransactionRow[]
): ReconcileStageResult {
  const db = getDb()

  const dbAccountRows = db
    .select()
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .all()

  const dbMatchRows = dbAccountRows.map(toDbMatchRow)

  const selfHeal = findDbSelfHealPairs(dbMatchRows)
  const selfHealIds = new Set(selfHeal.map((p) => p.pendingId))
  const remainingDbRows = dbMatchRows.filter((r) => !selfHealIds.has(r.id))

  const fuzzy = matchIncoming(remainingDbRows, rows)
  const consumedIncoming = new Set<number>([
    ...fuzzy.upgrades.map((m) => m.incomingIndex),
    ...fuzzy.refreshes.map((m) => m.incomingIndex),
    ...fuzzy.skips.map((m) => m.incomingIndex),
  ])
  const unconsumedRows = rows.filter((_, i) => !consumedIncoming.has(i))

  // occurrence slots per hash from every non-deleted DB row. Rows being
  // updated keep their old hash occupied on purpose: an identical pending
  // copy in the same file must count as a duplicate, not insert a phantom.
  const existingByHash = new Map<string, Set<number>>()
  for (const r of dbMatchRows) {
    if (selfHealIds.has(r.id)) continue
    if (r.sourceHash && typeof r.occurrenceIndex === "number") {
      let set = existingByHash.get(r.sourceHash)
      if (!set) {
        set = new Set()
        existingByHash.set(r.sourceHash, set)
      }
      set.add(r.occurrenceIndex)
    }
  }

  interface UpdatePlan {
    dbRow: DbMatchRow
    parsed: ParsedTransactionRow
    newHash: string
    occurrenceIndex: number
  }
  const updateById = new Map(dbMatchRows.map((r) => [r.id, r]))
  const fuzzyUpdates: UpdatePlan[] = []
  for (const m of [...fuzzy.upgrades, ...fuzzy.refreshes]) {
    const parsed = rows[m.incomingIndex]
    const newHash = hashTransaction(accountIban, parsed)
    const set = existingByHash.get(newHash) ?? new Set<number>()
    const occurrenceIndex = lowestFreeIndex(set)
    set.add(occurrenceIndex)
    existingByHash.set(newHash, set)
    fuzzyUpdates.push({
      dbRow: updateById.get(m.dbId)!,
      parsed,
      newHash,
      occurrenceIndex,
    })
  }

  const dedupe = computeDedupe(
    accountIban,
    accountId,
    batchId,
    unconsumedRows,
    existingByHash
  )

  db.transaction((tx) => {
    for (const pair of selfHeal) {
      tx.delete(transactions)
        .where(eq(transactions.id, pair.pendingId))
        .run()
    }

    // updated rows keep their id but get a fresh hash + lowest-free
    // occurrence slot; their old slot is released first
    for (const u of fuzzyUpdates) {
      const newHash = hashTransaction(accountIban, u.parsed)
      const oldSet = existingByHash.get(u.dbRow.sourceHash)
      oldSet?.delete(u.dbRow.occurrenceIndex)
      const newSet = existingByHash.get(newHash) ?? new Set<number>()
      const occ = lowestFreeIndex(newSet)
      newSet.add(occ)
      existingByHash.set(newHash, newSet)
      tx.update(transactions)
        .set({
          batchId,
          bookingDate: u.parsed.bookingDate,
          valueDate: u.parsed.valueDate,
          status: u.parsed.status,
          payer: u.parsed.payer || null,
          payee: u.parsed.payee || null,
          purpose: u.parsed.purpose || null,
          type: u.parsed.type,
          counterpartyIban: u.parsed.counterpartyIban || null,
          amountCents: u.parsed.amountCents,
          creditorId: u.parsed.creditorId || null,
          mandateRef: u.parsed.mandateRef || null,
          customerRef: u.parsed.customerRef || null,
          sourceHash: newHash,
          occurrenceIndex: occ,
          hashVersion: HASH_VERSION,
          labelStatus: "pending",
          labelAttempts: 0,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(transactions.id, u.dbRow.id))
        .run()
    }

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
    }
  })

  const totalInDb = db
    .select({ count: sql<number>`count(*)` })
    .from(transactions)
    .where(eq(transactions.batchId, batchId))
    .get()
  // updated rows keep their id but were re-pointed to this batch, so the
  // raw batch count includes them; imported means newly inserted rows only
  const updatedCount = fuzzyUpdates.length
  const skippedCount = fuzzy.skips.length
  const deletedCount = selfHeal.length
  const imported = (totalInDb?.count ?? 0) - updatedCount
  const duplicateCount = skippedCount + dedupe.duplicateCount

  db.update(importBatches)
    .set({
      rowsImported: imported,
      rowsDuplicate: duplicateCount,
      rowsUpdated: updatedCount,
      labelsTotal: imported,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(importBatches.id, batchId))
    .run()

  return {
    insertedCount: dedupe.toInsert.length,
    updatedCount,
    deletedCount,
    skippedCount,
    duplicateCount,
    totalRows: rows.length,
    imported,
  }
}
