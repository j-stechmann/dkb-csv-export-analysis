import { eq, inArray } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { accounts, importBatches } from "@/lib/db/schema"
import { sniffBank, CsvParseError } from "@/lib/csv/parser"
import { runReconcileAndDedupeStage } from "@/lib/import/reconcile"
import { hasLabelableRows, pruneOrphanCategories } from "@/lib/labeller/service"
import { STUCK_STAGES, type ImportStage } from "@/lib/db/status"
import { dkbGlobals, type DkbGlobals } from "@/lib/globals"

export type { ImportStage }
// re-exported for the API routes and tests that consumed them via pipeline
export { runReconcileAndDedupeStage } from "@/lib/import/reconcile"
export type { ReconcileStageResult } from "@/lib/import/reconcile"

export interface StartImportResult {
  batchId: string
}

export class ImportInProgressError extends Error {
  constructor() {
    super("another import is already in progress")
    this.name = "ImportInProgressError"
  }
}

function jobState(): NonNullable<DkbGlobals["__dkbImportJob"]> {
  const g = dkbGlobals()
  if (!g.__dkbImportJob) {
    g.__dkbImportJob = { running: false, currentBatchId: null }
  }
  return g.__dkbImportJob
}

export function isImportRunning(): boolean {
  return jobState().running
}

export function currentBatchId(): string | null {
  return jobState().currentBatchId
}

/** Peek account info synchronously — no DB writes on failure. */
export function peekAccount(csvContent: string) {
  return sniffBank(csvContent).sniff(csvContent)
}

/**
 * Kick the background import job. The account/batch rows are created
 * inside the job (after full parse) so a parse failure leaves no orphan
 * rows. The CSV content is passed through memory — the job body executes
 * synchronously, so no temp-file round trip is needed (and its disk-full
 * / cleanup failure modes disappear).
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

  // claim the job slot BEFORE running: the job body executes synchronously
  // (no awaits), so setting the flag afterwards would leave it stuck on true
  state.running = true
  state.currentBatchId = batchId

  // fire-and-forget with full error containment; the flag reset is chained
  // onto the promise so it lands in a microtask after startImport returns —
  // this stays correct even if the job gains awaits later
  void runImportJob(batchId, fileName, csvContent)
    .catch((err) => {
      console.error(`[import] unhandled job error batch=${batchId}:`, err)
    })
    .finally(() => {
      state.running = false
      state.currentBatchId = null
    })

  return { batchId }
}

async function runImportJob(
  batchId: string,
  fileName: string,
  csvContent: string
): Promise<void> {
  const db = getDb()
  try {
    // ── stage: parsing ──────────────────────────────────────────────
    db.insert(importBatches)
      .values({ id: batchId, fileName, status: "parsing" })
      .run()

    let parsed
    try {
      parsed = sniffBank(csvContent).parse(csvContent)
    } catch (err) {
      const message =
        err instanceof CsvParseError
          ? err.message
          : `parse failed: ${err instanceof Error ? err.message : String(err)}`
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
    // the stage is atomic end-to-end: the dedupe invariant is checked
    // inside its transaction, so a violation rolls the import back and
    // lands in the catch below with a clean DB
    runReconcileAndDedupeStage(account.iban, account.id, batchId, parsed.rows)

    // ── stage: labeling (owned by the background worker) ────────────
    // the import job stops here; the label worker drains the batch and
    // marks it completed once no labelable pending rows remain. A batch
    // that owns no labelable rows at all (all Nicht gebucht / deduped to
    // nothing labelable) completes right away.
    if (hasLabelableRows(batchId)) {
      db.update(importBatches)
        .set({ status: "labeling", updatedAt: new Date().toISOString() })
        .where(eq(importBatches.id, batchId))
        .run()
    } else {
      db.update(importBatches)
        .set({
          status: "completed",
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(importBatches.id, batchId))
        .run()
      pruneOrphanCategories()
    }
  } catch (err) {
    db.update(importBatches)
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(importBatches.id, batchId))
      .run()
  }
  // job-state flags are reset in startImport's .finally() on the promise
}

/**
 * Mark batches stuck in non-terminal states as failed (startup recovery).
 * 'labeling' is intentionally excluded: the label worker resumes those
 * batches after a restart (rows persist; drain detection re-completes them).
 */
export function resetStuckBatches(): number {
  const db = getDb()
  const result = db
    .update(importBatches)
    .set({
      status: "failed",
      error: "interrupted by server restart",
      updatedAt: new Date().toISOString(),
    })
    .where(inArray(importBatches.status, [...STUCK_STAGES]))
    .returning({ id: importBatches.id })
    .all()
  return result.length
}
