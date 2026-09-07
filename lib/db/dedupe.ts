import { createHash } from "node:crypto"
import type { ParsedTransactionRow } from "@/lib/csv/parser"
import type { NewTransaction } from "@/lib/db/schema"

/**
 * v2: counterparty_iban joined the content hash. Rows stored under v1
 * hashes are re-hashed once by migrateSchema (guarded by PRAGMA user_version).
 */
export const HASH_VERSION = 2

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
 * Occurrence slots per source hash: which occurrence indices are occupied
 * in the DB (per account). Shared by the reconcile plan and apply phases so
 * both compute identical slots for the same state transitions.
 *
 * Invariant: while planning updates, a row being updated KEEPS its old
 * slot occupied on purpose — an identical pending copy in the same file
 * must count as a duplicate, not insert a phantom. The old slot is
 * released only when the update is applied.
 */
export class OccurrenceSlots {
  private readonly byHash = new Map<string, Set<number>>()

  static fromRows(
    rows: Array<{ sourceHash: string; occurrenceIndex: number }>
  ): OccurrenceSlots {
    const slots = new OccurrenceSlots()
    for (const r of rows) slots.add(r.sourceHash, r.occurrenceIndex)
    return slots
  }

  private add(hash: string, occurrence: number): void {
    this.slotsFor(hash).add(occurrence)
  }

  private slotsFor(hash: string): Set<number> {
    let set = this.byHash.get(hash)
    if (!set) {
      set = new Set()
      this.byHash.set(hash, set)
    }
    return set
  }

  /** Reserve the lowest free slot under `hash` and return it. */
  occupyLowest(hash: string): number {
    const set = this.slotsFor(hash)
    const candidate = lowestFreeIndex(set)
    set.add(candidate)
    return candidate
  }

  /** Release a slot (update path: the row moves to a fresh hash). */
  release(hash: string, occurrence: number): void {
    this.byHash.get(hash)?.delete(occurrence)
  }

  /**
   * View of occupied slots per hash — shared with computeDedupe, which
   * both reads and mutates the sets (inserted slots stay occupied).
   */
  raw(): Map<string, Set<number>> {
    return this.byHash
  }
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
    const group = groups.get(hash)
    if (!group) {
      throw new Error(`computeDedupe: missing group for hash ${hash}`)
    }
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
      if (!row) {
        throw new Error(`computeDedupe: missing row ${placed} for ${hash}`)
      }
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
 * The counterparty IBAN is part of the content (v2): two rows differing
 * only in IBAN are distinct transactions, not duplicates.
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
    row.counterpartyIban,
    row.creditorId,
    row.mandateRef,
    row.customerRef,
  ]
  const h = createHash("sha256")
  h.update(parts.join("|"), "utf8")
  return h.digest("hex")
}
