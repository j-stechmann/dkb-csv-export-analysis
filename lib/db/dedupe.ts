import { createHash } from "node:crypto"
import type { ParsedTransactionRow } from "@/lib/csv/parser"
import type { NewTransaction } from "@/lib/db/schema"

export const HASH_VERSION = 1

export interface DedupeResult {
  toInsert: NewTransaction[]
  duplicateCount: number
  totalRows: number
  /** rows_imported + rows_duplicate === totalRows must hold after insert */
}

/**
 * Lowest non-negative integer not in `occupied` (used for occurrence slots).
 */
export function lowestFreeIndex(occupied: Set<number>): number {
  let candidate = 0
  while (occupied.has(candidate)) candidate++
  return candidate
}

/**
 * Occurrence-aware, count-based dedupe (multiset union):
 * - content hash over all normalized content fields (account-scoped)
 * - per hash: if the file contains N rows and the DB already has E,
 *   the first min(N, E) are duplicates and N-E rows are inserted at
 *   occurrence indices [existingCount, existingCount + surplus)
 * - re-import of the same file inserts nothing;
 *   overlapping exports insert only the surplus;
 *   identical same-day transactions are all preserved.
 */
export function computeDedupe(
  accountIban: string,
  accountId: number,
  batchId: string,
  rows: ParsedTransactionRow[],
  /** existing occurrence indices per source hash for this account */
  existingByHash: Map<string, Set<number>>
): DedupeResult {
  const toInsert: NewTransaction[] = []
  let duplicateCount = 0

  // group incoming rows by hash, preserving file order within groups
  const groups = new Map<string, ParsedTransactionRow[]>()
  const hashOrder: string[] = []
  for (const row of rows) {
    const hash = hashTransaction(accountIban, row)
    let group = groups.get(hash)
    if (!group) {
      group = []
      groups.set(hash, group)
      hashOrder.push(hash)
    }
    group.push(row)
  }

  for (const hash of hashOrder) {
    const group = groups.get(hash)!
    const existingOcc = existingByHash.get(hash) ?? new Set<number>()
    const incomingCount = group.length
    const existingCount = existingOcc.size

    // duplicates = the first `existingCount` occurrences that the DB
    // already holds (matched greedily against existing indices)
    const duplicateHere = Math.min(incomingCount, existingCount)
    duplicateCount += duplicateHere

    // insert surplus at the lowest free slots
    let toPlace = incomingCount - duplicateHere
    let placed = 0
    while (toPlace > 0) {
      const candidate = lowestFreeIndex(existingOcc)
      const row = group[duplicateHere + placed]
      toInsert.push(
        rowToNewTransaction(row, accountId, batchId, hash, candidate)
      )
      existingOcc.add(candidate)
      placed++
      toPlace--
    }
  }

  return {
    toInsert,
    duplicateCount,
    totalRows: rows.length,
  }
}

export function rowToNewTransaction(
  row: ParsedTransactionRow,
  accountId: number,
  batchId: string,
  sourceHash: string,
  occurrenceIndex: number
): NewTransaction {
  return {
    id: crypto.randomUUID(),
    accountId,
    batchId,
    bookingDate: row.bookingDate,
    valueDate: row.valueDate,
    status: row.status,
    payer: row.payer || null,
    payee: row.payee || null,
    purpose: row.purpose || null,
    type: row.type,
    counterpartyIban: row.counterpartyIban || null,
    amountCents: row.amountCents,
    creditorId: row.creditorId || null,
    mandateRef: row.mandateRef || null,
    customerRef: row.customerRef || null,
    sourceHash,
    occurrenceIndex,
    hashVersion: HASH_VERSION,
  }
}

/**
 * SHA-256 over hash_version + account + normalized content fields.
 * Both party names are included (direction-dependent counterparty would
 * otherwise be ambiguous). Account scoping prevents cross-account merges.
 */
export function hashTransaction(
  accountIban: string,
  row: ParsedTransactionRow
): string {
  const parts = [
    String(HASH_VERSION),
    accountIban.toUpperCase(),
    row.bookingDate,
    row.valueDate,
    String(row.amountCents),
    row.payer,
    row.payee,
    row.purpose,
    row.type,
    row.status,
    row.creditorId,
    row.mandateRef,
    row.customerRef,
  ]
  const h = createHash("sha256")
  h.update(parts.join("|"), "utf8")
  return h.digest("hex")
}
