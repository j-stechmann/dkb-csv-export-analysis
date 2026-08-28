import { and, eq, inArray } from "drizzle-orm"
import { getDb } from "@/lib/db"
import {
  categories,
  transactions,
} from "@/lib/db/schema"
import {
  LabellerClient,
  labelWithChunking,
  type LabellerInput,
} from "@/lib/labeller/client"

export interface LabelRunSummary {
  labeled: number
  failed: number
}

/**
 * Label all transactions with label_status in the given states.
 * Processes in bounded chunks so a sweep doesn't starve imports.
 * Returns counts; failures increment label_attempts.
 */
export async function runLabeling(
  labelStatuses: Array<"pending" | "failed">,
  maxItems?: number
): Promise<LabelRunSummary> {
  const db = getDb()
  const client = new LabellerClient()

  const health = await client.health()
  if (health !== "ok") {
    return { labeled: 0, failed: 0 }
  }

  const limit = maxItems ?? 5_000
  const rows = db
    .select({
      id: transactions.id,
      amountCents: transactions.amountCents,
      payer: transactions.payer,
      payee: transactions.payee,
      purpose: transactions.purpose,
      bookingDate: transactions.bookingDate,
      type: transactions.type,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.labelStatus, labelStatuses),
        eq(transactions.status, "Gebucht")
      )
    )
    .limit(limit)
    .all()

  if (rows.length === 0) {
    return { labeled: 0, failed: 0 }
  }

  const inputs: LabellerInput[] = rows.map((r) => ({
    id: r.id,
    amountCents: r.amountCents,
    counterparty: r.type === "Ausgang" ? (r.payee ?? "") : (r.payer ?? ""),
    purpose: r.purpose ?? "",
    bookingDate: r.bookingDate,
  }))

  let labeled = 0
  let failed = 0

  await labelWithChunking(client, inputs, async (results) => {
    const byId = new Map(results.map((r) => [r.id, r.label]))

    db.transaction((tx) => {
      for (const [id, label] of byId) {
        const nameKey = normalizeCategoryKey(label)
        let cat = tx
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.nameKey, nameKey))
          .get()
        if (!cat) {
          const inserted = tx
            .insert(categories)
            .values({
              name: label,
              nameKey,
              language: "de",
            })
            .onConflictDoNothing()
            .returning({ id: categories.id })
            .get()
          cat = inserted ?? tx
            .select({ id: categories.id })
            .from(categories)
            .where(eq(categories.nameKey, nameKey))
            .get()
        }
        if (!cat) {
          failed++
          continue
        }
        tx
          .update(transactions)
          .set({
            categoryId: cat.id,
            labelStatus: "labeled",
            labelAttempts: 0,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(transactions.id, id))
          .run()
        labeled++
      }
    })
  })

  return { labeled, failed }
}

/** upsert helper shared with pipeline; normalizes label names */
export function normalizeCategoryKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ")
}

/** prune categories that no transaction references */
export function pruneOrphanCategories(): number {
  const db = getDb()
  const result = db.run(
    `DELETE FROM categories WHERE id NOT IN (SELECT DISTINCT category_id FROM transactions WHERE category_id IS NOT NULL)`
  )
  return result.changes
}