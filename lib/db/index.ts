import fs from "node:fs"
import path from "node:path"
import { drizzle } from "drizzle-orm/better-sqlite3"
import Database from "better-sqlite3"
import * as schema from "./schema"
import { getConfig } from "@/lib/config"

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

type DbHolder = { __dkbDb?: Db }

const globalRef = globalThis as unknown as {
  __dkbDbHolder?: DbHolder
  __dkbTestDb?: Db
}

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

/** Create all tables idempotently (drizzle-kit push equivalent, code-first). */
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
      labels_total INTEGER NOT NULL DEFAULT 0,
      labels_done INTEGER NOT NULL DEFAULT 0,
      labels_failed INTEGER NOT NULL DEFAULT 0,
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
  // label_rules: CREATE TABLE IF NOT EXISTS handles fresh files; older DBs
  // created before this feature also get the table here (idempotent).
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
}
