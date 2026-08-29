import { describe, it, expect } from "vitest"
import { computeDedupe, hashTransaction } from "@/lib/db/dedupe"
import type { ParsedTransactionRow } from "@/lib/csv/parser"

function row(
  overrides: Partial<ParsedTransactionRow> = {}
): ParsedTransactionRow {
  return {
    bookingDate: "2026-02-03",
    valueDate: "2026-02-03",
    status: "Gebucht",
    payer: "MAX MUSTERMANN",
    payee: "REWE",
    purpose: "Einkauf",
    type: "Ausgang",
    counterpartyIban: "DE02100100123456789001",
    amountCents: -100,
    creditorId: "",
    mandateRef: "",
    customerRef: "",
    ...overrides,
  }
}

const ACC_IBAN = "DE02120300000000202051"

describe("computeDedupe", () => {
  /** simulate DB state helper: rows → Map<hash, Set<occurrence>> */
  function toDbState(
    inserted: Array<{ sourceHash?: string; occurrenceIndex?: number }>
  ) {
    const m = new Map<string, Set<number>>()
    for (const t of inserted) {
      if (t.sourceHash === undefined || t.occurrenceIndex === undefined) {
        continue
      }
      let s = m.get(t.sourceHash)
      if (!s) {
        s = new Set()
        m.set(t.sourceHash, s)
      }
      s.add(t.occurrenceIndex)
    }
    return m
  }

  it("keeps identical same-day transactions (17x -1 € stays 17)", () => {
    const rows = Array.from({ length: 17 }, () => row({ amountCents: -100 }))
    const result = computeDedupe(ACC_IBAN, 1, "b1", rows, new Map())
    expect(result.toInsert).toHaveLength(17)
    expect(result.duplicateCount).toBe(0)
    expect(result.totalRows).toBe(17)
    const occurrences = result.toInsert.map((t) => t.occurrenceIndex ?? -1)
    expect(new Set(occurrences).size).toBe(17)
    expect(occurrences.every((o) => o >= 0 && o < 17)).toBe(true)
  })

  it("re-import of the same file inserts nothing", () => {
    const rows = [row(), row(), row({ amountCents: -250 })]
    const first = computeDedupe(ACC_IBAN, 1, "b1", rows, new Map())
    expect(first.toInsert).toHaveLength(3)

    const dbState = toDbState(first.toInsert)
    const second = computeDedupe(ACC_IBAN, 1, "b2", rows, dbState)
    expect(second.toInsert).toHaveLength(0)
    expect(second.duplicateCount).toBe(3)
    expect(second.totalRows).toBe(3)
  })

  it("overlapping exports insert only the surplus (multiset union)", () => {
    // DB already has 2x hash A, 1x hash B
    const existingRows = [row(), row(), row({ amountCents: -250 })]
    const first = computeDedupe(ACC_IBAN, 1, "b1", existingRows, new Map())
    const dbState = toDbState(first.toInsert)

    // new file: 3x hash A (one new), 1x hash B, 1x hash C (new)
    const newFile = [
      row(),
      row(),
      row(),
      row({ amountCents: -250 }),
      row({ amountCents: -999 }),
    ]
    const second = computeDedupe(ACC_IBAN, 1, "b2", newFile, dbState)
    expect(second.toInsert).toHaveLength(2) // 1x A surplus + 1x C
    expect(second.duplicateCount).toBe(3)
    // invariant: imported + duplicates === total
    expect(second.toInsert.length + second.duplicateCount).toBe(
      second.totalRows
    )
    // the new A row must get occurrence_index 2 (lowest free slot)
    const aInsert = second.toInsert.find((t) => t.amountCents === -100)
    expect(aInsert?.occurrenceIndex).toBe(2)
    void aInsert
  })

  it("account scoping: same content on different accounts both insert", () => {
    const rows = [row()]
    // DB state for account 2 keyed under a DIFFERENT hash namespace —
    // computeDedupe receives only account-1 state, so this row inserts.
    const hOtherAccount = "hash-of-account-2-row"
    const dbState = new Map([[hOtherAccount, new Set([0])]])
    const result = computeDedupe(ACC_IBAN, 1, "b1", rows, dbState)
    expect(result.toInsert).toHaveLength(1)
    expect(result.duplicateCount).toBe(0)
  })

  it("gap in occurrence indices does not overcount duplicates", () => {
    // DB holds this account's hash with occurrences {0, 2}; incoming 2 rows
    // → both are duplicates (count-based, not slot-based)
    const rows = [row(), row()]
    const first = computeDedupe(ACC_IBAN, 1, "b1", rows, new Map())
    const h = first.toInsert[0].sourceHash
    const dbState = new Map([[h, new Set([0, 1, 5])]]) // 3 existing
    const result = computeDedupe(ACC_IBAN, 1, "b1", rows, dbState)
    expect(result.toInsert).toHaveLength(0)
    expect(result.duplicateCount).toBe(2)
  })

  it("different content fields produce different hashes", () => {
    const variants = [
      row({ payee: "REWE ANDERS" }),
      row({ purpose: "anders" }),
      row({ amountCents: -101 }),
      row({ bookingDate: "2026-02-04" }),
      row({ payer: "ANDERER" }),
      row({ type: "Eingang", amountCents: 100 }),
      row({ status: "Nicht gebucht" }),
    ]
    const hashes = new Set(variants.map((v) => hashTransaction(ACC_IBAN, v)))
    expect(hashes.size).toBe(variants.length)
  })
})
