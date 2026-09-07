import fs from "node:fs"
import path from "node:path"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/better-sqlite3"
import Database from "better-sqlite3"
import * as schema from "./schema"
import { getConfig } from "@/lib/config"
import { hashTransaction, HASH_VERSION } from "./dedupe"
import type { TxStatus } from "./status"
import { dkbGlobals } from "@/lib/globals"

export type Db = ReturnType<typeof createDb>
/** Transaction callback parameter type (for helpers receiving `tx`). */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0]

function createDb() {
  const dbPath = getConfig().DATABASE_PATH
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })
  const sqlite = new Database(dbPath)
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("foreign_keys = ON")
  sqlite.pragma("busy_timeout = 5000")
  return drizzle(sqlite, { schema })
}

const globalRef = dkbGlobals()
export function getDb(): Db {
  if (process.env.VITEST && globalRef.__dkbTestDb) {
    return globalRef.__dkbTestDb
  }
  if (!globalRef.__dkbDbHolder) {
    globalRef.__dkbDbHolder = {}
  }
  const holder = globalRef.__dkbDbHolder
  if (!holder.__dkbDb) {
    holder.__dkbDb = createDb()
    createSchemaSqlite(holder.__dkbDb)
  }
  // cheap idempotent re-check so a hot-reloaded schema heals the file DB
  migrateSchema(holder.__dkbDb)
  return holder.__dkbDb
}

/** For tests: inject an in-memory DB. */
export function setTestDb(db: Db) {
  globalRef.__dkbTestDb = db
}

export function createTestDb(): Db {
  const sqlite = new Database(":memory:")
  sqlite.pragma("foreign_keys = ON")
  const db = drizzle(sqlite, { schema })
  createSchemaSqlite(db)
  return db
}

/** Create all tables idempotently (code-first DDL; schema-parity test locks it to the drizzle schema). */
export function createSchemaSqlite(db: Db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      iban TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS accounts_iban_unique ON accounts (iban)`
  )
  db.run(`
    CREATE TABLE IF NOT EXISTS import_batches (
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
      rows_updated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `)
  db.run(
    `CREATE INDEX IF NOT EXISTS import_batches_status_idx ON import_batches (status)`
  )
  db.run(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      language TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'llm',
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `)
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS categories_name_key_unique ON categories (name_key)`
  )
  db.run(`
    CREATE TABLE IF NOT EXISTS label_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      iban TEXT NOT NULL,
      name_key TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS label_rules_iban_name_key_unique ON label_rules (iban, name_key)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS label_rules_iban_idx ON label_rules (iban)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS label_rules_label_idx ON label_rules (label_id)`
  )
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
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
    )
  `)
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS transactions_dedupe_unique ON transactions (account_id, source_hash, occurrence_index)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS transactions_account_booking_idx ON transactions (account_id, booking_date)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS transactions_booking_date_idx ON transactions (booking_date)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS transactions_label_status_idx ON transactions (label_status)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS transactions_batch_id_idx ON transactions (batch_id)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS transactions_category_idx ON transactions (category_id)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS transactions_payee_idx ON transactions (payee)`
  )
}

/** Ensure schema exists on the default (file) database. */
export function ensureSchema() {
  const db = getDb()
  createSchemaSqlite(db)
  migrateSchema(db)
}

/**
 * Idempotent migrations: column additions for tables that already exist on
 * disk (CREATE TABLE IF NOT EXISTS never alters a live table). Re-checked on
 * every getDb() so a hot-reload picks up new columns without a restart.
 */
export function migrateSchema(db: Db) {
  const cols = (table: string) =>
    db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)
  if (!cols("import_batches").includes("rows_updated")) {
    db.run(
      `ALTER TABLE import_batches ADD COLUMN rows_updated INTEGER NOT NULL DEFAULT 0`
    )
  }
  if (!cols("categories").includes("origin")) {
    db.run(
      `ALTER TABLE categories ADD COLUMN origin TEXT NOT NULL DEFAULT 'llm'`
    )
  }
  if (!cols("categories").includes("usage_count")) {
    db.run(
      `ALTER TABLE categories ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0`
    )
  }
  // label counters are computed on read; the persisted columns had no
  // consistent writer and no reader — drop them from older DBs
  if (cols("import_batches").includes("labels_total")) {
    db.run(`ALTER TABLE import_batches DROP COLUMN labels_total`)
  }
  if (cols("import_batches").includes("labels_done")) {
    db.run(`ALTER TABLE import_batches DROP COLUMN labels_done`)
  }
  if (cols("import_batches").includes("labels_failed")) {
    db.run(`ALTER TABLE import_batches DROP COLUMN labels_failed`)
  }
  rehashV1Transactions(db)
}

/**
 * One-shot migration from hash version 1 (content hash missing
 * counterparty_iban) to the current version. Guarded by PRAGMA user_version.
 * Legacy rows are re-hashed from their stored fields, oldest first, and
 * claim fresh occurrence slots per (account, new hash) — the dense
 * reassignment preserves the multiset semantics of identical-content rows
 * (all survive, distinct slots, same as a fresh import). Orphan rows
 * without an account (FK corruption) are dropped.
 */
function rehashV1Transactions(db: Db) {
  const version = Number(
    db.all<{ user_version: number }>(`PRAGMA user_version`)[0]?.user_version ??
      0
  )
  if (version >= HASH_VERSION) return

  const legacy = db.all<{
    id: string
    account_id: number
    counterparty_iban: string | null
    created_at: string
    booking_date: string
    value_date: string | null
    status: TxStatus
    payer: string | null
    payee: string | null
    purpose: string | null
    type: string
    amount_cents: number
    creditor_id: string | null
    mandate_ref: string | null
    customer_ref: string | null
  }>(
    `SELECT id, account_id, counterparty_iban, created_at, booking_date, value_date,
            status, payer, payee, purpose, type, amount_cents, creditor_id,
            mandate_ref, customer_ref
     FROM transactions
     WHERE hash_version < ${HASH_VERSION}
     ORDER BY created_at ASC, id ASC`
  )

  if (legacy.length > 0) {
    const ibanByAccountId = new Map(
      db
        .all<{ id: number; iban: string }>(`SELECT id, iban FROM accounts`)
        .map((a) => [a.id, a.iban])
    )

    // occupied slots per "accountId|newHash"; current-version rows keep
    // their exact slots (the unique index already guarantees one row per
    // (account, hash, occurrence))
    const slots = new Map<string, Set<number>>()
    const occupied = new Set(
      db
        .all<{
          account_id: number
          source_hash: string
          occurrence_index: number
        }>(
          `SELECT account_id, source_hash, occurrence_index FROM transactions WHERE hash_version >= ${HASH_VERSION}`
        )
        .map((r) => `${r.account_id}|${r.source_hash}|${r.occurrence_index}`)
    )
    const claimSlot = (key: string): number => {
      let set = slots.get(key)
      if (!set) {
        set = new Set()
        slots.set(key, set)
      }
      let c = 0
      while (set.has(c) || occupied.has(`${key}|${c}`)) c++
      set.add(c)
      return c
    }

    db.transaction((tx) => {
      for (const r of legacy) {
        const accountIban = ibanByAccountId.get(r.account_id)
        if (!accountIban) {
          // account vanished (FK corruption): drop the orphan row
          tx.run(sql`DELETE FROM transactions WHERE id = ${r.id}`)
          continue
        }
        const newHash = hashTransaction(accountIban, {
          bookingDate: r.booking_date,
          valueDate: r.value_date ?? "",
          status: r.status,
          payer: r.payer ?? "",
          payee: r.payee ?? "",
          purpose: r.purpose ?? "",
          type: r.type,
          counterpartyIban: r.counterparty_iban ?? "",
          amountCents: r.amount_cents,
          creditorId: r.creditor_id ?? "",
          mandateRef: r.mandate_ref ?? "",
          customerRef: r.customer_ref ?? "",
        })
        const slot = claimSlot(`${r.account_id}|${newHash}`)
        tx.run(sql`UPDATE transactions
                   SET source_hash = ${newHash}, occurrence_index = ${slot}, hash_version = ${HASH_VERSION}
                   WHERE id = ${r.id}`)
      }
    })
  }

  db.run(`PRAGMA user_version = ${HASH_VERSION}`)
}
