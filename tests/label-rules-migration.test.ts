import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { sql } from "drizzle-orm"
import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { migrateSchema, type Db } from "@/lib/db"

/**
 * Builds a pre-tuple-format file DB (the schema every existing deployment
 * had) and runs migrateSchema over it. createTestDb always builds the new
 * format, so the migration path needs its own harness.
 */
function createLegacyDb(): { db: Db; path: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dkb-mig-"))
  const file = path.join(dir, "legacy.db")
  const sqlite = new Database(file)
  sqlite.pragma("foreign_keys = ON")
  sqlite.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      language TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'llm',
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX categories_name_key_unique ON categories (name_key);
    CREATE TABLE label_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      iban TEXT NOT NULL,
      name_key TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX label_rules_iban_name_key_unique ON label_rules (iban, name_key);
    CREATE INDEX label_rules_iban_idx ON label_rules (iban);
    CREATE INDEX label_rules_label_idx ON label_rules (label_id);
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      iban TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE import_batches (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      account_id INTEGER REFERENCES accounts(id),
      status TEXT NOT NULL DEFAULT 'parsing',
      error TEXT,
      snapshot_date TEXT,
      snapshot_amount_cents INTEGER,
      rows_total INTEGER NOT NULL DEFAULT 0,
      rows_imported INTEGER NOT NULL DEFAULT 0,
      rows_duplicate INTEGER NOT NULL DEFAULT 0,
      labels_total INTEGER NOT NULL DEFAULT 0,
      labels_done INTEGER NOT NULL DEFAULT 0,
      labels_failed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      batch_id TEXT REFERENCES import_batches(id),
      booking_date TEXT NOT NULL,
      value_date TEXT,
      status TEXT NOT NULL DEFAULT 'Gebucht',
      payer TEXT,
      payee TEXT,
      purpose TEXT,
      type TEXT NOT NULL,
      counterparty_iban TEXT,
      amount_cents INTEGER NOT NULL,
      creditor_id TEXT,
      mandate_ref TEXT,
      customer_ref TEXT,
      category_id INTEGER REFERENCES categories(id),
      label_status TEXT NOT NULL DEFAULT 'pending',
      label_attempts INTEGER NOT NULL DEFAULT 0,
      source_hash TEXT NOT NULL,
      occurrence_index INTEGER NOT NULL DEFAULT 0,
      hash_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  sqlite.close()
  const db = drizzle(new Database(file)) as unknown as Db
  return { db, path: file }
}

const IBAN = "DE02120300000000202051"

function seedCategory(db: Db) {
  db.run(
    sql`INSERT INTO categories (name, name_key, language, origin, usage_count, created_at)
        VALUES ('Miete', 'miete', 'de', 'manual', 0, '2026-01-01')`
  )
}

function seedLegacyEvidence(db: Db) {
  db.run(
    sql`INSERT INTO accounts (iban, name, created_at) VALUES (${IBAN}, 'Girokonto', '2026-01-01')`
  )
  seedCategory(db)
  // transaction evidence for the legacy rule: direction-counterparty (payee,
  // Ausgang) normalizes to the rule's name_key 'edeka'
  db.run(
    sql`INSERT INTO transactions (id, account_id, booking_date, status, payer, payee, type, counterparty_iban, amount_cents, source_hash, created_at, updated_at)
        VALUES ('tx-1', 1, '2026-02-03', 'Gebucht', 'ISSUER', 'EDEKA', 'Ausgang', ${"de02 1203 0000 0000 2020 51"}, -100, 'h1', '2026-01-01', '2026-01-01')`
  )
}

describe("label_rules tuple migration", () => {
  it("revives a legacy rule from transaction evidence", () => {
    const { db } = createLegacyDb()
    seedLegacyEvidence(db)
    db.run(
      sql`INSERT INTO label_rules (label_id, iban, name_key, name, created_at, updated_at)
          VALUES (1, ${IBAN}, 'edeka', 'EDEKA', '2026-01-01', '2026-01-01')`
    )

    migrateSchema(db)

    const rows = db.all<Record<string, string>>(
      sql`SELECT payer_key, payee_key, payer, payee, name_key, name FROM label_rules`
    ) as unknown as {
      payer_key: string
      payee_key: string
      payer: string
      payee: string
      name_key: string
      name: string
    }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].payer_key).toBe("issuer")
    expect(rows[0].payee_key).toBe("edeka")
    expect(rows[0].payer).toBe("ISSUER")
    expect(rows[0].payee).toBe("EDEKA")

    const indexes = (
      db.all<{ name: string }>(
        sql`PRAGMA index_list(label_rules)`
      ) as unknown as { name: string }[]
    ).map((i) => i.name)
    expect(indexes).toContain("label_rules_iban_payer_payee_unique")
    expect(indexes).not.toContain("label_rules_iban_name_key_unique")
  })

  it("falls back to payee_key = name_key without evidence (inert rule)", () => {
    const { db } = createLegacyDb()
    seedCategory(db)
    db.run(
      sql`INSERT INTO label_rules (label_id, iban, name_key, name, created_at, updated_at)
          VALUES (1, ${IBAN}, 'no-evidence', 'No Evidence', '2026-01-01', '2026-01-01')`
    )

    migrateSchema(db)

    const rows = db.all<Record<string, string>>(
      sql`SELECT payer_key, payee_key, payee FROM label_rules`
    ) as unknown as {
      payer_key: string
      payee_key: string
      payee: string
    }[]
    expect(rows[0].payer_key).toBe("")
    expect(rows[0].payee_key).toBe("no evidence")
    expect(rows[0].payee).toBe("No Evidence")
  })

  it("merges legacy siblings that normalize onto the same tuple (newest wins)", () => {
    const { db } = createLegacyDb()
    seedCategory(db)
    // two rules on one iban whose name_keys both normalize to 'edeka'
    db.run(
      sql`INSERT INTO label_rules (label_id, iban, name_key, name, created_at, updated_at)
          VALUES (1, ${IBAN}, 'edeka', 'EDEKA', '2026-01-01', '2026-01-01')`
    )
    db.run(
      sql`INSERT INTO label_rules (label_id, iban, name_key, name, created_at, updated_at)
          VALUES (1, ${IBAN}, 'edeka gmbh', 'EDEKA GmbH', '2026-01-02', '2026-01-02')`
    )

    migrateSchema(db)

    const rows = db.all<{ name_key: string }>(
      sql`SELECT name_key FROM label_rules`
    ) as unknown as { name_key: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].name_key).toBe("edeka gmbh")
  })

  it("is idempotent: re-running migrateSchema keeps data and index", () => {
    const { db } = createLegacyDb()
    seedCategory(db)
    db.run(
      sql`INSERT INTO label_rules (label_id, iban, name_key, name, created_at, updated_at)
          VALUES (1, ${IBAN}, 'edeka', 'EDEKA', '2026-01-01', '2026-01-01')`
    )

    migrateSchema(db)
    migrateSchema(db)
    migrateSchema(db)

    expect((db.all(sql`SELECT * FROM label_rules`) as unknown[]).length).toBe(1)
    const indexes = (
      db.all<{ name: string }>(
        sql`PRAGMA index_list(label_rules)`
      ) as unknown as { name: string }[]
    ).map((i) => i.name)
    expect(indexes).toContain("label_rules_iban_payer_payee_unique")
  })

  it("ignores evidence whose other side is unusable (stays inert)", () => {
    const { db } = createLegacyDb()
    seedCategory(db)
    db.run(
      sql`INSERT INTO accounts (iban, name, created_at) VALUES (${IBAN}, 'Girokonto', '2026-01-01')`
    )
    // Ausgang evidence for 'edeka' but with an empty payer — adopting its
    // tuple would leave payer_key '' (a rule that looks revived but never
    // matches), so the rule must fall back to the inert form instead
    db.run(
      sql`INSERT INTO transactions (id, account_id, booking_date, status, payer, payee, type, counterparty_iban, amount_cents, source_hash, created_at, updated_at)
          VALUES ('tx-3', 1, '2026-02-05', 'Gebucht', '', 'EDEKA', 'Ausgang', ${"de02 1203 0000 0000 2020 51"}, -100, 'h3', '2026-01-01', '2026-01-01')`
    )
    db.run(
      sql`INSERT INTO label_rules (label_id, iban, name_key, name, created_at, updated_at)
          VALUES (1, ${IBAN}, 'edeka', 'EDEKA', '2026-01-01', '2026-01-01')`
    )

    migrateSchema(db)

    const rows = db.all<{
      payer_key: string
      payee_key: string
      payer: string
    }>(sql`SELECT payer_key, payee_key, payer FROM label_rules`) as unknown as {
      payer_key: string
      payee_key: string
      payer: string
    }[]
    expect(rows[0].payer_key).toBe("")
    expect(rows[0].payee_key).toBe("edeka")
    // legacy display snapshot untouched by the inert fallback
    expect(rows[0].payer).toBe("")
  })

  it("backfilled tuple actually matches transactions (round-trip)", async () => {
    const { db } = createLegacyDb()
    seedLegacyEvidence(db)
    db.run(
      sql`INSERT INTO label_rules (label_id, iban, name_key, name, created_at, updated_at)
          VALUES (1, ${IBAN}, 'edeka', 'EDEKA', '2026-01-01', '2026-01-01')`
    )
    migrateSchema(db)

    // the revived rule's tuple matches the transaction via the service matcher
    const { findRuleMatches } = await import("@/lib/labeller/service")
    const matches = findRuleMatches(db, {
      ibanKey: IBAN,
      payerKey: "issuer",
      payeeKey: "edeka",
    })
    expect(matches.map((m) => m.id)).toEqual(["tx-1"])
  })

  it("two rules adopting the same evidence tuple fall back instead of colliding", () => {
    const { db } = createLegacyDb()
    seedLegacyEvidence(db)
    // rule A ('edeka') matches the Ausgang evidence (payer=ISSUER, payee=EDEKA)
    // and adopts tuple (issuer, edeka). rule B ('issuer') matches the Eingang
    // rendering of the same pair (payer=ISSUER, payee=EDEKA) — adopting it
    // would collide with A on the tuple index, so B must stay inert.
    db.run(
      sql`INSERT INTO categories (name, name_key, language, origin, usage_count, created_at)
          VALUES ('Essen', 'essen', 'de', 'manual', 0, '2026-01-01')`
    )
    db.run(
      sql`INSERT INTO transactions (id, account_id, booking_date, status, payer, payee, type, counterparty_iban, amount_cents, source_hash, created_at, updated_at)
          VALUES ('tx-2', 1, '2026-02-04', 'Gebucht', 'ISSUER', 'EDEKA', 'Eingang', ${"de02 1203 0000 0000 2020 51"}, 100, 'h2', '2026-01-01', '2026-01-01')`
    )
    db.run(
      sql`INSERT INTO label_rules (label_id, iban, name_key, name, created_at, updated_at)
          VALUES (1, ${IBAN}, 'edeka', 'EDEKA', '2026-01-01', '2026-01-01')`
    )
    db.run(
      sql`INSERT INTO label_rules (label_id, iban, name_key, name, created_at, updated_at)
          VALUES (2, ${IBAN}, 'issuer', 'ISSUER', '2026-01-02', '2026-01-02')`
    )

    expect(() => migrateSchema(db)).not.toThrow()

    const rows = db.all<{
      payer_key: string
      payee_key: string
      name_key: string
    }>(
      sql`SELECT payer_key, payee_key, name_key FROM label_rules ORDER BY id`
    ) as unknown as {
      payer_key: string
      payee_key: string
      name_key: string
    }[]
    // first rule adopted the tuple, second stayed on the inert fallback
    expect(rows).toHaveLength(2)
    expect(rows[0].payer_key).toBe("issuer")
    expect(rows[0].payee_key).toBe("edeka")
    expect(rows[1].payer_key).toBe("")
    expect(rows[1].payee_key).toBe("issuer")
  })
})
