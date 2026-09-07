import { and, eq, inArray } from "drizzle-orm"
import { getDb, type Db, type DbTx } from "@/lib/db"
import { categories, labelRules } from "@/lib/db/schema"

/** A rule key: all three fields must be non-empty, non-whitespace strings. */
export interface RulePartyInput {
  payer: string | null
  payee: string | null
  counterpartyIban: string | null
}

export interface LearnedRuleInput extends RulePartyInput {
  labelId: number
}

/**
 * A rule key is only learnable/matchable when every component carries real
 * content: non-null and not (trim-)empty. Values are compared and stored
 * verbatim — no normalization.
 */
export function isUsableRuleKey(input: {
  payer: string | null
  payee: string | null
  counterpartyIban: string | null
}): input is { payer: string; payee: string; counterpartyIban: string } {
  return (
    input.payer !== null &&
    input.payer.trim() !== "" &&
    input.payee !== null &&
    input.payee.trim() !== "" &&
    input.counterpartyIban !== null &&
    input.counterpartyIban.trim() !== ""
  )
}

/**
 * Looks up suggestions for one transaction: the rule whose (payer, payee,
 * counterpartyIban) triple matches exactly. The unique index allows at most
 * one rule per triple, so the result is that rule's label or nothing.
 */
export function suggestLabelIds(db: Db, input: RulePartyInput): number[] {
  if (!isUsableRuleKey(input)) return []

  const row = db
    .select({ labelId: labelRules.labelId })
    .from(labelRules)
    .where(
      and(
        eq(labelRules.payer, input.payer),
        eq(labelRules.payee, input.payee),
        eq(labelRules.counterpartyIban, input.counterpartyIban)
      )
    )
    .get()
  return row ? [row.labelId] : []
}

/**
 * Upserts a learned rule (manual assignment path): keyed on
 * (payer, payee, counterpartyIban). Re-learning the same triple for a new
 * label replaces the rule (newest wins). Returns the rule id, or null when
 * the transaction lacks payer, payee or counterparty IBAN.
 */
export function learnRule(
  tx: Db | DbTx,
  input: LearnedRuleInput
): number | null {
  if (!isUsableRuleKey(input)) return null

  const now = new Date().toISOString()
  const existing = tx
    .select({ id: labelRules.id })
    .from(labelRules)
    .where(
      and(
        eq(labelRules.payer, input.payer),
        eq(labelRules.payee, input.payee),
        eq(labelRules.counterpartyIban, input.counterpartyIban)
      )
    )
    .get()
  if (existing) {
    tx.update(labelRules)
      .set({ labelId: input.labelId, updatedAt: now })
      .where(eq(labelRules.id, existing.id))
      .run()
    return existing.id
  }
  const inserted = tx
    .insert(labelRules)
    .values({
      labelId: input.labelId,
      payer: input.payer,
      payee: input.payee,
      counterpartyIban: input.counterpartyIban,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: labelRules.id })
    .get()
  if (inserted) return inserted.id
  const reRead = tx
    .select({ id: labelRules.id })
    .from(labelRules)
    .where(
      and(
        eq(labelRules.payer, input.payer),
        eq(labelRules.payee, input.payee),
        eq(labelRules.counterpartyIban, input.counterpartyIban)
      )
    )
    .get()
  return reRead?.id ?? null
}

/**
 * Batch suggestion lookup: resolves label ids per transaction index.
 * Each distinct (payer, payee, counterpartyIban) triple is queried once,
 * then mapped back to every transaction sharing it.
 */
export function suggestForBatch(
  inputs: RulePartyInput[]
): Map<number, number[]> {
  const db = getDb()
  const byTriple = new Map<string, number[]>()
  const result = new Map<number, number[]>()
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]
    if (!isUsableRuleKey(input)) {
      result.set(i, [])
      continue
    }
    const key = `${input.payer}\u0000${input.payee}\u0000${input.counterpartyIban}`
    let ids = byTriple.get(key)
    if (!ids) {
      ids = suggestLabelIds(db, input)
      byTriple.set(key, ids)
    }
    result.set(i, ids)
  }
  return result
}

/**
 * Resolves label ids to names for the prompt. Missing ids (deleted label)
 * are skipped.
 */
export function resolveLabelNames(
  db: Db,
  labelIds: number[]
): Map<number, string> {
  if (labelIds.length === 0) return new Map()
  const rows = db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(inArray(categories.id, labelIds))
    .all()
  return new Map(rows.map((r) => [r.id, r.name]))
}
