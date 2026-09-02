import { eq, inArray, sql } from "drizzle-orm"
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

/** Mark claimed rows as failed (chunk error path); attempts stay incremented. */
export function markRowsFailed(ids: string[]): void {
  if (ids.length === 0) return
  const db = getDb()
  db.update(transactions)
    .set({ labelStatus: "failed", updatedAt: new Date().toISOString() })
    .where(inArray(transactions.id, ids))
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
 */
export function completeDrainedBatches(): number {
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
