import { eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { importBatches, transactions } from "@/lib/db/schema"
import type { ParsedTransactionRow } from "@/lib/csv/parser"
import {
  computeDedupe,
  hashTransaction,
  HASH_VERSION,
  OccurrenceSlots,
} from "@/lib/db/dedupe"
import {
  findBookedSelfHealPairs,
  findDbSelfHealPairs,
  matchIncoming,
  toDbMatchRow,
  type DbMatchRow,
} from "@/lib/db/match"

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
 * all mutations in ONE transaction (atomic end-to-end: reads, plan, writes,
 * invariant check and batch counters commit together or not at all):
 * 1. self-heal: delete DB pending rows that match a DB booked row
 * 2. booked self-heal: delete the newer DB row of stored booked↔booked
 *    re-render pairs (same Kundenreferenz, different content — DKB changed
 *    the payee rendering between export formats)
 * 3. classify incoming rows vs DB (upgrades / skip / refresh; booked
 *    incoming with an already-stored bank identity is a skip)
 * 4. exact dedupe tier on unconsumed rows only
 * 5. apply: deletes → in-place updates (fresh hash + occurrence slot) →
 *    inserts (real insert count via RETURNING, not a post-commit count)
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

  // booked↔booked re-renders (same Kundenreferenz, different content):
  // the newer duplicated copy becomes a delete candidate before matching,
  // so the incoming file cannot pair with it again
  const createdAtById = new Map(
    dbAccountRows.map((r) => [r.id, r.createdAt] as const)
  )
  const bookedHeal = findBookedSelfHealPairs(dbMatchRows, createdAtById)
  const bookedHealIds = new Set(bookedHeal.map((p) => p.deleteId))
  const effectiveDbRows = remainingDbRows.filter(
    (r) => !bookedHealIds.has(r.id)
  )

  const fuzzy = matchIncoming(effectiveDbRows, rows)
  const consumedIncoming = new Set<number>([
    ...fuzzy.upgrades.map((m) => m.incomingIndex),
    ...fuzzy.refreshes.map((m) => m.incomingIndex),
    ...fuzzy.skips.map((m) => m.incomingIndex),
  ])
  const unconsumedRows = rows.filter((_, i) => !consumedIncoming.has(i))

  // occurrence slots per hash from every non-deleted DB row (updates keep
  // their old slot occupied during planning — see OccurrenceSlots)
  const slots = OccurrenceSlots.fromRows(
    dbMatchRows
      .filter((r) => !selfHealIds.has(r.id) && !bookedHealIds.has(r.id))
      .map((r) => ({
        sourceHash: r.sourceHash,
        occurrenceIndex: r.occurrenceIndex,
      }))
  )

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
    if (!parsed) {
      throw new Error(`reconcile: incoming row ${m.incomingIndex} vanished`)
    }
    const dbRow = updateById.get(m.dbId)
    if (!dbRow) {
      throw new Error(`reconcile: db row ${m.dbId} vanished`)
    }
    const newHash = hashTransaction(accountIban, parsed)
    const occurrenceIndex = slots.occupyLowest(newHash)
    fuzzyUpdates.push({ dbRow, parsed, newHash, occurrenceIndex })
  }

  const dedupe = computeDedupe(
    accountIban,
    accountId,
    batchId,
    unconsumedRows,
    slots.raw()
  )

  const updatedCount = fuzzyUpdates.length
  const skippedCount = fuzzy.skips.length
  const deletedCount = selfHeal.length + bookedHeal.length
  const duplicateCount = skippedCount + dedupe.duplicateCount
  const inserted = { count: 0 }

  db.transaction((tx) => {
    for (const pair of selfHeal) {
      tx.delete(transactions).where(eq(transactions.id, pair.pendingId)).run()
    }

    for (const pair of bookedHeal) {
      tx.delete(transactions).where(eq(transactions.id, pair.deleteId)).run()
    }

    // updated rows keep their id but get a fresh hash + the occurrence
    // slot reserved during planning; their old slot is released here
    for (const u of fuzzyUpdates) {
      slots.release(u.dbRow.sourceHash, u.dbRow.occurrenceIndex)
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
          sourceHash: u.newHash,
          occurrenceIndex: u.occurrenceIndex,
          hashVersion: HASH_VERSION,
          labelStatus: "pending",
          labelAttempts: 0,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(transactions.id, u.dbRow.id))
        .run()
    }

    for (const row of dedupe.toInsert) {
      const res = tx
        .insert(transactions)
        .values(row)
        .onConflictDoNothing({
          target: [
            transactions.accountId,
            transactions.sourceHash,
            transactions.occurrenceIndex,
          ],
        })
        .returning({ id: transactions.id })
        .get()
      if (res) inserted.count++
    }

    // invariant BEFORE commit: every incoming row is classified exactly
    // once as insert / duplicate / update — a violation rolls everything
    // back instead of leaving a half-applied import
    if (inserted.count + duplicateCount + updatedCount !== rows.length) {
      throw new Error(
        `dedupe invariant violated: imported(${inserted.count}) + duplicates(${duplicateCount}) + updated(${updatedCount}) !== total(${rows.length})`
      )
    }

    tx.update(importBatches)
      .set({
        rowsImported: inserted.count,
        rowsDuplicate: duplicateCount,
        rowsUpdated: updatedCount,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(importBatches.id, batchId))
      .run()
  })

  return {
    insertedCount: inserted.count,
    updatedCount,
    deletedCount,
    skippedCount,
    duplicateCount,
    totalRows: rows.length,
    imported: inserted.count,
  }
}
