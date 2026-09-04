import { and, eq, inArray } from "drizzle-orm"
import { getDb, type Db, type DbTx } from "@/lib/db"
import { categories, labelRules } from "@/lib/db/schema"
import {
  counterpartyDisplayName,
  isLearnableIbanKey,
  normalizeCounterpartyKey,
  normalizeIbanKey,
} from "@/lib/db/normalize"
import { getConfig } from "@/lib/config"

export interface SuggestionInput {
  counterpartyIban: string | null
}

export interface LearnedRuleInput {
  counterpartyIban: string | null
  counterpartyName: string | null
  labelId: number
}

/** Transaction-like row the worker passes for suggestion lookup. */
export interface TxLike {
  id: string
  counterpartyIban: string | null
}

/**
 * Looks up suggestions for one transaction: ALL rules whose normalized IBAN
 * key matches, deduped by label, ranked usageCount desc → manual before
 * llm → newest rule first, capped at LLM_MAX_SUGGESTIONS.
 */
export function suggestLabelIds(
  db: Db,
  counterpartyIban: string | null
): number[] {
  const ibanKey = normalizeIbanKey(counterpartyIban)
  if (!ibanKey) return []

  const rows = db
    .select({
      labelId: labelRules.labelId,
      ruleCreatedAt: labelRules.createdAt,
      usageCount: categories.usageCount,
      origin: categories.origin,
    })
    .from(labelRules)
    .innerJoin(categories, eq(categories.id, labelRules.labelId))
    .where(eq(labelRules.iban, ibanKey))
    .all()

  const originRank = (origin: string) => (origin === "manual" ? 0 : 1)
  rows.sort(
    (a, b) =>
      b.usageCount - a.usageCount ||
      originRank(a.origin) - originRank(b.origin) ||
      b.ruleCreatedAt.localeCompare(a.ruleCreatedAt) ||
      a.labelId - b.labelId
  )

  const seen = new Set<number>()
  const out: number[] = []
  const cap = getConfig().LLM_MAX_SUGGESTIONS
  for (const row of rows) {
    if (seen.has(row.labelId)) continue
    seen.add(row.labelId)
    out.push(row.labelId)
    if (out.length >= cap) break
  }
  return out
}

/**
 * Upserts a learned rule (manual assignment path): keyed on
 * (ibanKey, counterpartyNameKey). Re-assignment of the same rendering to a
 * new label replaces the rule (newest wins); sibling renderings keep their
 * own rules. Returns the rule id, or null when the key is not learnable.
 */
export function learnRule(
  tx: Db | DbTx,
  input: LearnedRuleInput
): number | null {
  const ibanKey = normalizeIbanKey(input.counterpartyIban)
  if (!ibanKey || !isLearnableIbanKey(ibanKey)) return null
  const nameKey = normalizeCounterpartyKey(input.counterpartyName)
  const name = counterpartyDisplayName(input.counterpartyName)
  if (!nameKey || !name) return null

  const now = new Date().toISOString()
  const existing = tx
    .select({ id: labelRules.id })
    .from(labelRules)
    .where(and(eq(labelRules.iban, ibanKey), eq(labelRules.nameKey, nameKey)))
    .get()
  if (existing) {
    tx.update(labelRules)
      .set({ labelId: input.labelId, name, updatedAt: now })
      .where(eq(labelRules.id, existing.id))
      .run()
    return existing.id
  }
  const inserted = tx
    .insert(labelRules)
    .values({
      labelId: input.labelId,
      iban: ibanKey,
      nameKey,
      name,
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
    .where(and(eq(labelRules.iban, ibanKey), eq(labelRules.nameKey, nameKey)))
    .get()
  return reRead?.id ?? null
}

/**
 * Batch suggestion lookup: resolves label ids per transaction index.
 * Each distinct IBAN key is queried once, then mapped back to every
 * transaction sharing it.
 */
export function suggestForBatch(
  inputs: SuggestionInput[]
): Map<number, number[]> {
  const db = getDb()
  const byIban = new Map<string, number[]>()
  const result = new Map<number, number[]>()
  for (let i = 0; i < inputs.length; i++) {
    const ibanKey = normalizeIbanKey(inputs[i].counterpartyIban)
    if (!ibanKey) {
      result.set(i, [])
      continue
    }
    let ids = byIban.get(ibanKey)
    if (!ids) {
      ids = suggestLabelIds(db, ibanKey)
      byIban.set(ibanKey, ids)
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
