import { describe, it, expect, beforeEach } from "vitest"
import { drizzle } from "drizzle-orm/better-sqlite3"
import Database from "better-sqlite3"
import * as schema from "@/lib/db/schema"
import {
  createTestDb,
  createSchemaSqlite,
  migrateSchema,
  setTestDb,
  type Db,
} from "@/lib/db"
import { accounts, importBatches, transactions } from "@/lib/db/schema"
import { hashTransaction, HASH_VERSION } from "@/lib/db/dedupe"
import { runReconcileAndDedupeStage } from "@/lib/import/pipeline"
import { parseDkbCsv } from "@/lib/csv/parser"
import type { ParsedTransactionRow } from "@/lib/csv/parser"

const ACC_IBAN = "DE02120300000000202051"
const ACC_NAME = "Girokonto"

function row(
  overrides: Partial<ParsedTransactionRow> = {}
): ParsedTransactionRow {
  return {
    bookingDate: "2026-02-03",
    valueDate: "2026-02-03",
    status: "Gebucht",
    payer: "",
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

const HEADER =
  "Buchungsdatum;Wertstellung;Status;Zahlungspflichtige*r;Zahlungsempfänger*in;Verwendungszweck;Umsatztyp;IBAN;Betrag (€);Gläubiger-ID;Mandatsreferenz;Kundenreferenz"

function csvWithRows(dataRows: string[]): string {
  return [
    "Girokonto;DE02120300000000202051;",
    "Zeitraum:;01.01.2026 – 28.02.2026;",
    "Kontostand vom 28.02.2026:;1.234,56 €;",
    "",
    HEADER,
    ...dataRows,
  ].join("\n")
}

function startBatch(db: Db, accountId: number, batchId: string): string {
  db.insert(importBatches)
    .values({
      id: batchId,
      fileName: `${batchId}.csv`,
      accountId,
      status: "importing",
    })
    .run()
  return batchId
}

describe("dedupe hash includes counterparty IBAN (v2)", () => {
  it("rows differing only in counterpartyIban get different hashes", () => {
    const a = row({ counterpartyIban: "DE02100100123456789001" })
    const b = row({ counterpartyIban: "DE02100100123456789002" })
    expect(hashTransaction(ACC_IBAN, a)).not.toBe(hashTransaction(ACC_IBAN, b))
  })

  it("two booked rows differing only by IBAN both insert and re-import cleanly", () => {
    const db = createTestDb()
    setTestDb(db)
    const accountId = db
      .insert(accounts)
      .values({ iban: ACC_IBAN, name: ACC_NAME })
      .returning()
      .get().id

    startBatch(db, accountId, "b1")
    const res1 = runReconcileAndDedupeStage(ACC_IBAN, accountId, "b1", [
      row({ counterpartyIban: "DE02100100123456789001" }),
      row({ counterpartyIban: "DE02100100123456789002" }),
    ])
    expect(res1.insertedCount).toBe(2)
    expect(res1.duplicateCount).toBe(0)
    expect(db.select().from(transactions).all()).toHaveLength(2)

    // re-import of the same file: both are duplicates now, nothing inserted
    startBatch(db, accountId, "b2")
    const res2 = runReconcileAndDedupeStage(ACC_IBAN, accountId, "b2", [
      row({ counterpartyIban: "DE02100100123456789001" }),
      row({ counterpartyIban: "DE02100100123456789002" }),
    ])
    expect(res2.insertedCount).toBe(0)
    expect(res2.duplicateCount).toBe(2)
    expect(db.select().from(transactions).all()).toHaveLength(2)
  })

  it("CSV-level: two same-day rows differing only by IBAN import both", () => {
    const csv = csvWithRows([
      "03.02.26;03.02.26;Gebucht;A;REWE;Einkauf;Ausgang;DE02100100123456789001;-42,13;;;",
      "03.02.26;03.02.26;Gebucht;A;REWE;Einkauf;Ausgang;DE02100100123456789002;-42,13;;;",
    ])
    const parsed = parseDkbCsv(csv)
    expect(parsed.rows).toHaveLength(2)
  })
})

describe("rehash migration (v1 → v2)", () => {
  let db: Db
  let accountId: number

  beforeEach(() => {
    // build a raw DB WITHOUT running the migration, insert v1-style rows
    const sqlite = new Database(":memory:")
    sqlite.pragma("foreign_keys = ON")
    db = drizzle(sqlite, { schema }) as unknown as Db
    createSchemaSqlite(db)
    accountId = db
      .insert(accounts)
      .values({ iban: ACC_IBAN, name: ACC_NAME })
      .returning()
      .get().id
  })

  function seedV1Row(
    overrides: Partial<{
      id: string
      counterparty_iban: string | null
      created_at: string
    }> = {}
  ) {
    const id = overrides.id ?? `v1-${crypto.randomUUID()}`
    db.run(
      `INSERT INTO transactions (id, account_id, batch_id, booking_date, value_date, status, payer, payee, purpose, type, counterparty_iban, amount_cents, creditor_id, mandate_ref, customer_ref, label_status, label_attempts, source_hash, occurrence_index, hash_version, created_at, updated_at)
       VALUES ('${id}', ${accountId}, NULL, '2026-02-03', '2026-02-03', 'Gebucht', '', 'REWE', 'Einkauf', 'Ausgang', ${overrides.counterparty_iban === null ? "NULL" : `'${overrides.counterparty_iban ?? "DE02100100123456789001"}'`}, -100, '', '', '', 'pending', 0, 'legacy-${id}', 0, 1, ${overrides.created_at ? `'${overrides.created_at}'` : "'2026-01-01T00:00:00.000Z'"}, '2026-01-01T00:00:00.000Z')`
    )
    return id
  }

  it("migrates v1 rows to current-version hashes including the IBAN", () => {
    seedV1Row({ id: "v1-a", counterparty_iban: "DE02100100123456789001" })
    seedV1Row({ id: "v1-b", counterparty_iban: "DE02100100123456789002" })

    migrateSchema(db)

    const rows = db.select().from(transactions).all()
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.hashVersion).toBe(HASH_VERSION)
    }
    // distinct IBANs → distinct hashes
    expect(new Set(rows.map((r) => r.sourceHash)).size).toBe(2)

    // the new hash is exactly hashTransaction over the stored fields
    const expectedA = hashTransaction(
      ACC_IBAN,
      row({
        counterpartyIban: "DE02100100123456789001",
      })
    )
    expect(rows.find((r) => r.id === "v1-a")!.sourceHash).toBe(expectedA)

    // guard set → migration does not run again
    expect(
      db.all<{ user_version: number }>(`PRAGMA user_version`)[0]?.user_version
    ).toBe(HASH_VERSION)
  })

  it("is idempotent: a second migrateSchema call changes nothing", () => {
    seedV1Row({ id: "v1-x" })
    migrateSchema(db)
    const afterFirst = db.select().from(transactions).all()
    migrateSchema(db)
    expect(db.select().from(transactions).all()).toEqual(afterFirst)
  })

  it("identical-content v1 rows survive the rehash with distinct slots", () => {
    seedV1Row({ id: "dup-1" })
    seedV1Row({ id: "dup-2" })
    seedV1Row({ id: "dup-3" })

    migrateSchema(db)

    const rows = db.select().from(transactions).all()
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((r) => r.occurrenceIndex)).size).toBe(3)
    // after migration, a re-import of the same content is pure duplicate
    setTestDb(db)
    startBatch(db, accountId, "post")
    const res = runReconcileAndDedupeStage(
      ACC_IBAN,
      accountId,
      "post",
      Array.from({ length: 3 }, () => row())
    )
    expect(res.insertedCount).toBe(0)
    expect(res.duplicateCount).toBe(3)
  })
})
