import { and, eq, inArray } from "drizzle-orm"
import { getDb, type Db, type DbTx } from "@/lib/db"
import { categories, labelRules } from "@/lib/db/schema"
import {
  counterpartyDisplayName,
  isLearnableIbanKey,
  normalizeCounterpartyKey,
  normalizeIbanKey,
} from "@/lib/db/normalize"
import type { RuleTuple } from "@/lib/labeller/service"

export interface SuggestionInput {
  counterpartyIban: string | null
  payer: string | null
  payee: string | null
}

export interface LearnedRuleInput {
  counterpartyIban: string | null
  payer: string | null
  payee: string | null
  labelId: number
}

export type RuleKey = RuleTuple

/**
 * Normalized (iban, payer, payee) tuple for a transaction. Both name keys
 * are required: a rule identifies the exact counterparty combination, so an
 * unusable name (normalizes to empty) yields no matchable key.
 */
export function ruleKeyFor(input: {
  counterpartyIban: string | null
  payer: string | null
  payee: string | null
}): RuleKey | null {
  const ibanKey = normalizeIbanKey(input.counterpartyIban)
  if (!ibanKey) return null
  const payerKey = normalizeCounterpartyKey(input.payer)
  const payeeKey = normalizeCounterpartyKey(input.payee)
  if (!payerKey || !payeeKey) return null
  return { ibanKey, payerKey, payeeKey }
}

/**
 * Looks up the rule for one exact (iban, payer, payee) tuple. The unique
 * index guarantees at most one match, so the return is 0..1 label ids —
 * the historical multi-suggestion ranking/cap is gone with tuple identity.
 */
export function suggestLabelIds(db: Db, key: RuleKey): number[] {
  const row = db
    .select({ labelId: labelRules.labelId })
    .from(labelRules)
    .where(
      and(
        eq(labelRules.iban, key.ibanKey),
        eq(labelRules.payerKey, key.payerKey),
        eq(labelRules.payeeKey, key.payeeKey)
      )
    )
    .get()
  return row ? [row.labelId] : []
}

/**
 * Upserts a learned rule (manual assignment path): keyed on the exact
 * (ibanKey, payerKey, payeeKey) tuple. Re-assignment of the same tuple to a
 * new label replaces the rule (newest wins). Returns the rule id, or null
 * when the tuple is not learnable.
 */
export function learnRule(
  tx: Db | DbTx,
  input: LearnedRuleInput
): number | null {
  const key = ruleKeyFor(input)
  if (!key || !isLearnableIbanKey(key.ibanKey)) return null
  const payer = counterpartyDisplayName(input.payer)
  const payee = counterpartyDisplayName(input.payee)

  const now = new Date().toISOString()
  const existing = tx
    .select({ id: labelRules.id })
    .from(labelRules)
    .where(
      and(
        eq(labelRules.iban, key.ibanKey),
        eq(labelRules.payerKey, key.payerKey),
        eq(labelRules.payeeKey, key.payeeKey)
      )
    )
    .get()
  if (existing) {
    tx.update(labelRules)
      .set({ labelId: input.labelId, payer, payee, updatedAt: now })
      .where(eq(labelRules.id, existing.id))
      .run()
    return existing.id
  }
  const inserted = tx
    .insert(labelRules)
    .values({
      labelId: input.labelId,
      iban: key.ibanKey,
      payerKey: key.payerKey,
      payeeKey: key.payeeKey,
      payer,
      payee,
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
        eq(labelRules.iban, key.ibanKey),
        eq(labelRules.payerKey, key.payerKey),
        eq(labelRules.payeeKey, key.payeeKey)
      )
    )
    .get()
  return reRead?.id ?? null
}

/**
 * Batch suggestion lookup: resolves label ids per transaction index.
 * Each distinct (iban, payer, payee) tuple is queried once, then mapped
 * back to every transaction sharing it.
 */
export function suggestForBatch(
  inputs: SuggestionInput[]
): Map<number, number[]> {
  const db = getDb()
  const byKey = new Map<string, number[]>()
  const result = new Map<number, number[]>()
  for (let i = 0; i < inputs.length; i++) {
    const key = ruleKeyFor(inputs[i])
    if (!key) {
      result.set(i, [])
      continue
    }
    const cacheKey = `${key.ibanKey}\u0000${key.payerKey}\u0000${key.payeeKey}`
    let ids = byKey.get(cacheKey)
    if (!ids) {
      ids = suggestLabelIds(db, key)
      byKey.set(cacheKey, ids)
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
