import { sql } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { transactions } from "@/lib/db/schema"
import type { ImportBatch } from "@/lib/db/schema"

export interface LabelCounters {
  labelsTotal: number
  labelsDone: number
  labelsFailed: number
}

/**
 * Compute label progress for a batch from live row ownership, so re-pointed
 * rows (fuzzy updates) and background relabels never drift the counters.
 * Invariant: done + failed + pending('Gebucht') = total.
 */
export function computeLabelCounters(batchId: string): LabelCounters {
  const db = getDb()
  const row = db
    .select({
      total: sql<number>`count(*)`,
      done: sql<number>`count(*) filter (where ${transactions.labelStatus} = 'labeled')`,
      failed: sql<number>`count(*) filter (where ${transactions.labelStatus} = 'failed')`,
    })
    .from(transactions)
    .where(
      sql`${transactions.batchId} = ${batchId} AND ${transactions.status} = 'Gebucht'`
    )
    .get()
  return {
    labelsTotal: row?.total ?? 0,
    labelsDone: row?.done ?? 0,
    labelsFailed: row?.failed ?? 0,
  }
}

export function withLabelCounters<B extends ImportBatch>(
  batch: B
): B & LabelCounters {
  return { ...batch, ...computeLabelCounters(batch.id) }
}
