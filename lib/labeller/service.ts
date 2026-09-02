import { and, eq, inArray, ne, sql } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { categories, importBatches, transactions } from "@/lib/db/schema"
import type { LabelResult } from "@/lib/labeller/client"

/**
 * Persist label results: upsert categories, mark rows labeled.
 * Must run inside one transaction so a chunk is all-or-nothing.
 * Returns the batch ids affected (for drain-check / progress reads).
 */
export function applyLabelResults(results: LabelResult[]): string[] {
  const db = getDb()
  const batchIds = new Set<string>()

  db.transaction((tx) => {
    for (const result of results) {
      const row = tx
        .select({ batchId: transactions.batchId })
        .from(transactions)
        .where(eq(transactions.id, result.id))
        .get()
      if (!row) continue
      if (row.batchId) batchIds.add(row.batchId)

      const nameKey = normalizeCategoryKey(result.label)
      let cat = tx
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.nameKey, nameKey))
        .get()
      if (!cat) {
        const inserted = tx
          .insert(categories)
          .values({
            name: result.label,
            nameKey,
            language: "de",
          })
          .onConflictDoNothing()
          .returning({ id: categories.id })
          .get()
        cat =
          inserted ??
          tx
            .select({ id: categories.id })
            .from(categories)
            .where(eq(categories.nameKey, nameKey))
            .get()
      }
      if (!cat) continue
      tx.update(transactions)
        .set({
          categoryId: cat.id,
          labelStatus: "labeled",
          labelAttempts: 0,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(transactions.id, result.id))
        .run()
    }
  })

  return [...batchIds]
}

/**
 * Mark claimed rows as failed (chunk error path); attempts stay incremented.
 * Rows that a previously-applied chunk already labeled are excluded so a
 * later chunk failure cannot flip them back to failed (they'd be re-claimed
 * and re-sent to the LLM, wasting calls and temporarily showing no category).
 */
export function markRowsFailed(ids: string[]): void {
  if (ids.length === 0) return
  const db = getDb()
  db.update(transactions)
    .set({ labelStatus: "failed", updatedAt: new Date().toISOString() })
    .where(
      and(
        inArray(transactions.id, ids),
        ne(transactions.labelStatus, "labeled")
      )
    )
    .run()
}

/** upsert helper shared with pipeline; normalizes label names */
export function normalizeCategoryKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ")
}

/**
 * A batch in 'labeling' is complete when it owns no labelable pending rows.
 * 'Gebucht' filter prevents deadlock for batches whose rows are all
 * 'Nicht gebucht' (never labelable). 'failed' rows never block; they are
 * retried via the retry endpoint or picked up on their next claimable tick.
 * Pending rows that exhausted their attempts also don't block: they are
 * unclaimable forever (claim filters attempts < cap) and would wedge the
 * batch otherwise — the retry endpoint can revive them with a fresh budget.
 */
export function completeDrainedBatches(maxAttempts: number): number {
  const db = getDb()
  const done = db
    .update(importBatches)
    .set({
      status: "completed",
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(
      sql`
      status = 'labeling' AND NOT EXISTS (
        SELECT 1 FROM transactions t
        WHERE t.batch_id = import_batches.id
          AND t.status = 'Gebucht'
          AND t.label_status = 'pending'
          AND t.label_attempts < ${maxAttempts}
      )
    `
    )
    .returning({ id: importBatches.id })
    .all()
  if (done.length > 0) pruneOrphanCategories()
  return done.length
}

/** prune categories that no transaction references */
export function pruneOrphanCategories(): number {
  const db = getDb()
  const result = db.run(
    `DELETE FROM categories WHERE id NOT IN (SELECT DISTINCT category_id FROM transactions WHERE category_id IS NOT NULL)`
  )
  return result.changes
}

/**
 * Batch owns pending 'Gebucht' rows the worker can claim. Used by the
 * pipeline right after insert/update (fresh rows always have attempts 0),
 * so no attempts filter is needed here. A false positive is harmless: the
 * batch transiently sits in 'labeling' until the next drain tick completes it.
 */
export function hasLabelableRows(batchId: string): boolean {
  const db = getDb()
  const row = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      sql`${transactions.batchId} = ${batchId}
        AND ${transactions.status} = 'Gebucht'
        AND ${transactions.labelStatus} = 'pending'`
    )
    .limit(1)
    .get()
  return row !== undefined
}
