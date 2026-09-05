import { and, eq, inArray, sql } from "drizzle-orm"
import { getDb, type Db, type DbTx } from "@/lib/db"
import { categories, importBatches, transactions } from "@/lib/db/schema"
import { normalizeIbanKey } from "@/lib/db/normalize"
import type { LabelResult } from "@/lib/llm/client"
import { sanitizeField } from "@/lib/llm/prompt"

/**
 * Resolve-or-create a category by name and bump its usageCount.
 * The single choke point for category writes (LLM apply + manual assign).
 * Runs inside the caller's transaction. Returns the category id.
 */
export function resolveAndUseCategory(tx: DbTx, name: string): number | null {
  const nameKey = normalizeCategoryKey(name)
  let cat = tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.nameKey, nameKey))
    .get()
  if (!cat) {
    const inserted = tx
      .insert(categories)
      .values({
        name: name.trim(),
        nameKey,
        language: "de",
        origin: "llm",
        usageCount: 0,
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
  if (!cat) return null
  tx.update(categories)
    .set({ usageCount: sql`${categories.usageCount} + 1` })
    .where(eq(categories.id, cat.id))
    .run()
  return cat.id
}

/**
 * Persist label results: upsert categories (usageCount++), mark rows labeled.
 * Must run inside one transaction so a chunk is all-or-nothing.
 * `claimedAttempts` maps row id → label_attempts captured at claim time;
 * a row whose attempts changed since then was reset by a concurrent
 * fuzzy-update, retry run, or manual assignment and is skipped (its label
 * would be stale — the manual label wins over in-flight LLM results).
 * Returns the batch ids affected (for drain-check / progress reads).
 */
export function applyLabelResults(
  results: LabelResult[],
  claimedAttempts: Map<string, number>
): string[] {
  const db = getDb()
  const batchIds = new Set<string>()

  db.transaction((tx) => {
    for (const result of results) {
      const row = tx
        .select({
          batchId: transactions.batchId,
          labelAttempts: transactions.labelAttempts,
        })
        .from(transactions)
        .where(eq(transactions.id, result.id))
        .get()
      if (!row) continue
      if (row.labelAttempts !== claimedAttempts.get(result.id)) continue
      if (row.batchId) batchIds.add(row.batchId)

      const catId = resolveAndUseCategory(tx, result.label)
      if (!catId) continue
      tx.update(transactions)
        .set({
          categoryId: catId,
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
 * Mark claimed rows as failed (chunk error path or empty model output);
 * attempts stay incremented. Rows that a previously-applied chunk already
 * labeled are excluded so a later chunk failure cannot flip them back to
 * failed (they'd be re-claimed and re-sent to the LLM, wasting calls and
 * temporarily showing no category).
 * Rows whose attempts changed since claim were reset by a concurrent
 * fuzzy-update or retry run — left untouched so their fresh content gets
 * labeled instead of being failed without ever being attempted.
 */
export function markRowsFailed(
  ids: string[],
  claimedAttempts: Map<string, number>
): void {
  if (ids.length === 0) return
  const db = getDb()
  db.transaction((tx) => {
    for (const id of ids) {
      const row = tx
        .select({
          labelStatus: transactions.labelStatus,
          labelAttempts: transactions.labelAttempts,
        })
        .from(transactions)
        .where(eq(transactions.id, id))
        .get()
      if (!row) continue
      if (row.labelStatus === "labeled") continue
      if (row.labelAttempts !== claimedAttempts.get(id)) continue
      tx.update(transactions)
        .set({ labelStatus: "failed", updatedAt: new Date().toISOString() })
        .where(eq(transactions.id, id))
        .run()
    }
  })
}

/** upsert helper shared with pipeline; normalizes label names */
export function normalizeCategoryKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ")
}

const textEncoder = new TextEncoder()

/**
 * Manual label names must be non-empty, at most 64 UTF-8 bytes, free of
 * control characters, and must survive sanitizeField (the prompt renderer)
 * unchanged. sanitizeLabel strips controls and neutralizes markers from
 * model output, and sanitizeField rewrites `|`/`<<`/`>>`/`index=` in the
 * suggestions list — so a stored name containing one could never normalize
 * back to its own nameKey and would instead create a phantom duplicate
 * category on every reuse ("Miete | Nebenkosten" renders as
 * "Miete / Nebenkosten"). Such names are rejected outright rather than
 * silently rewritten. The round-trip check subsumes the marker list, so it
 * cannot drift if sanitizeField's rewrite set ever changes.
 */
export function isValidLabelName(name: string): boolean {
  if (name.length === 0 || textEncoder.encode(name).length > 64) return false
  for (const c of name) {
    const code = c.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
  }
  return sanitizeField(name) === name
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

/**
 * Prune categories that no transaction references AND that carry no learned
 * rules — and only LLM-invented ones. Manual labels and any label still
 * referenced by a learned rule survive so user intent and suggestion
 * history are never silently destroyed.
 */
export function pruneOrphanCategories(): number {
  const db = getDb()
  const result = db.run(
    `DELETE FROM categories
     WHERE origin = 'llm'
       AND id NOT IN (SELECT DISTINCT category_id FROM transactions WHERE category_id IS NOT NULL)
       AND id NOT IN (SELECT DISTINCT label_id FROM label_rules)`
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

/**
 * Resets every transaction currently carrying `categoryId` to unlabeled so
 * the label worker re-labels them after the label is deleted. Also re-points
 * completed owning batches to 'labeling' (only 'completed' — parsing/
 * importing/failed keep their stage semantics) and refreshes their stale
 * labels_total. Returns the affected transaction ids.
 * Passing `existingTx` runs the reset inside that caller's transaction so the
 * reset and the subsequent category delete commit atomically (the DELETE
 * route wraps both to avoid a FK window for concurrent LLM applies).
 */
export function resetTransactionsForLabelDeletion(
  categoryId: number,
  existingTx?: DbTx
): string[] {
  const db = getDb()
  const handle = existingTx ?? db
  const affected = handle
    .select({
      id: transactions.id,
      batchId: transactions.batchId,
    })
    .from(transactions)
    .where(eq(transactions.categoryId, categoryId))
    .all()

  const run = (tx: DbTx) => {
    const batchIds = new Set<string>()
    for (const row of affected) {
      tx.update(transactions)
        .set({
          categoryId: null,
          labelStatus: "pending",
          labelAttempts: 0,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(transactions.id, row.id))
        .run()
      if (row.batchId) batchIds.add(row.batchId)
    }
    if (batchIds.size > 0) {
      const now = new Date().toISOString()
      tx.update(importBatches)
        .set({
          status: "labeling",
          labelsTotal: sql`(SELECT COUNT(*) FROM transactions t WHERE t.batch_id = import_batches.id AND t.status = 'Gebucht')`,
          updatedAt: now,
        })
        .where(
          and(
            inArray(importBatches.id, [...batchIds]),
            eq(importBatches.status, "completed")
          )
        )
        .run()
    }
  }

  if (existingTx) {
    run(existingTx)
  } else {
    db.transaction(run)
  }

  return affected.map((r) => r.id)
}

/**
 * Finds transactions whose counterparty IBAN matches `ibanKey` (rule-style
 * normalized comparison) and are labelable by the worker. Counterparty IBANs
 * are stored with interior spaces and export case, so the SQL prefilter
 * (UPPER/REPLACE) casts a wide net and the exact TS-side recheck with
 * normalizeIbanKey decides the match. The prefilter strips ASCII spaces
 * only — exact for everything the CSV parser stores (cleanCell collapses
 * all whitespace, including NBSP/U+202F, into single ASCII spaces before
 * insert); a hypothetical out-of-band writer leaving other whitespace or
 * non-ASCII letters (SQLite UPPER is ASCII-only, unlike JS toUpperCase)
 * would be matched by suggestLabelIds but missed here. NULL/empty
 * counterparty IBANs never match. Only 'Gebucht' rows are returned: the
 * worker never claims anything else, so including 'Nicht gebucht' rows
 * would only inflate counts.
 */
export function findIbanRuleMatches(
  db: Db | DbTx,
  ibanKey: string
): Array<{ id: string; batchId: string | null }> {
  if (!ibanKey) return []
  const candidates = db
    .select({
      id: transactions.id,
      batchId: transactions.batchId,
      counterpartyIban: transactions.counterpartyIban,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, "Gebucht"),
        sql`UPPER(REPLACE(${transactions.counterpartyIban}, ' ', '')) = ${ibanKey}`
      )
    )
    .all()
  return candidates.filter(
    (row) => normalizeIbanKey(row.counterpartyIban) === ibanKey
  )
}

/**
 * Applies a label rule to existing data (email-filter style): every matching
 * 'Gebucht' transaction is pointed at the rule's label and reset to pending
 * so the label worker re-labels it via the LLM — the rule is injected as a
 * suggestion and the model confirms the final label. Setting categoryId
 * immediately shows the rule's label in the UI while the row is pending.
 * Also re-points completed owning batches to 'labeling' and refreshes their
 * stale labels_total (same bookkeeping as label-deletion reset; done/failed
 * counters are computed on read and self-heal).
 * Passing `existingTx` runs inside the caller's transaction.
 */
export function applyIbanRuleToTransactions(
  ibanKey: string,
  labelId: number,
  existingTx?: DbTx
): string[] {
  const db = getDb()
  const handle = existingTx ?? db
  const affected = findIbanRuleMatches(handle, ibanKey)

  const run = (tx: DbTx) => {
    const batchIds = new Set<string>()
    const now = new Date().toISOString()
    for (const row of affected) {
      tx.update(transactions)
        .set({
          categoryId: labelId,
          labelStatus: "pending",
          labelAttempts: 0,
          updatedAt: now,
        })
        .where(eq(transactions.id, row.id))
        .run()
      if (row.batchId) batchIds.add(row.batchId)
    }
    if (batchIds.size > 0) {
      tx.update(importBatches)
        .set({
          status: "labeling",
          labelsTotal: sql`(SELECT COUNT(*) FROM transactions t WHERE t.batch_id = import_batches.id AND t.status = 'Gebucht')`,
          updatedAt: now,
        })
        .where(
          and(
            inArray(importBatches.id, [...batchIds]),
            eq(importBatches.status, "completed")
          )
        )
        .run()
    }
  }

  if (existingTx) {
    run(existingTx)
  } else {
    db.transaction(run)
  }

  return affected.map((r) => r.id)
}
