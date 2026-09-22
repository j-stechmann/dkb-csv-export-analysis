import fs from "node:fs"
import path from "node:path"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { sql } from "drizzle-orm"
import Database from "better-sqlite3"
import * as schema from "./schema"
import { getConfig } from "@/lib/config"
import { pickCategoryColor } from "@/lib/category-colors"

export type Db = ReturnType<typeof createDb>
/** Transaction callback parameter type (for helpers receiving `tx`). */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/**
 * One-time rename migration for the rebrand: the default DB file used to be
 * `dkb.db`. When the configured target does not exist yet but a pre-rebrand
 * `dkb.db` (with WAL sidecars) sits in the same directory, rename it over so
 * an upgrade keeps its data instead of silently starting fresh. The main
 * file moves first — a crash mid-rename leaves the target existing, which
 * makes the next boot skip the migration instead of re-pairing a stale WAL
 * with the db. An existing target is never overwritten; `:memory:` is a
 * no-op.
 */
function adoptLegacyDbFile(dbPath: string) {
  if (dbPath.includes(":memory:")) return
  const legacyPath = path.join(path.dirname(dbPath), "dkb.db")
  if (fs.existsSync(dbPath) || !fs.existsSync(legacyPath)) return
  fs.renameSync(legacyPath, dbPath)
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(legacyPath + suffix)) {
      fs.renameSync(legacyPath + suffix, dbPath + suffix)
    }
  }
  console.log(
    `[startup] adopted pre-rebrand database: ${legacyPath} → ${dbPath}`
  )
}

function createDb() {
  const dbPath = getConfig().DATABASE_PATH
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })
  adoptLegacyDbFile(dbPath)
  const sqlite = new Database(dbPath)
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("foreign_keys = ON")
  sqlite.pragma("busy_timeout = 5000")
  return drizzle(sqlite, { schema })
}

type DbHolder = { __geldlageDb?: Db }

const globalRef = globalThis as unknown as {
  __geldlageDbHolder?: DbHolder
  __geldlageTestDb?: Db
}

export function getDb(): Db {
  if (process.env.VITEST && globalRef.__geldlageTestDb) {
    return globalRef.__geldlageTestDb
  }
  if (!globalRef.__geldlageDbHolder) {
    globalRef.__geldlageDbHolder = {}
  }
  const holder = globalRef.__geldlageDbHolder
  if (!holder.__geldlageDb) {
    holder.__geldlageDb = createDb()
    createSchemaSqlite(holder.__geldlageDb)
  }
  // cheap idempotent re-check so a hot-reloaded schema heals the file DB
  migrateSchema(holder.__geldlageDb)
  return holder.__geldlageDb
}

/** For tests: inject an in-memory DB. */
export function setTestDb(db: Db) {
  globalRef.__geldlageTestDb = db
}

/** For tests: forget the default (file) DB singleton, e.g. after changing DATABASE_PATH. */
export function resetDefaultDbForTest() {
  globalRef.__geldlageDbHolder = undefined
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
  dropLegacyUserlessTables(db)
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS users_issuer_subject_unique ON users (issuer, subject)`
  )
  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      iban TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS accounts_user_iban_unique ON accounts (user_id, iban)`
  )
  db.run(`
    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
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
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      language TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'llm',
      usage_count INTEGER NOT NULL DEFAULT 0,
      color TEXT,
      created_at TEXT NOT NULL
    )
  `)
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS categories_user_name_key_unique ON categories (user_id, name_key)`
  )
  // Only when the table already has the column — old-shape DBs get it via
  // migrateSchema (which also creates the index after backfilling colors).
  {
    const categoryCols = db
      .all<{ name: string }>(`PRAGMA table_info(categories)`)
      .map((c) => c.name)
    if (categoryCols.includes("color")) {
      db.run(
        `CREATE UNIQUE INDEX IF NOT EXISTS categories_color_unique ON categories (color)`
      )
    }
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS label_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      label_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      payer TEXT NOT NULL CHECK (payer <> ''),
      payee TEXT NOT NULL CHECK (payee <> ''),
      counterparty_iban TEXT NOT NULL CHECK (counterparty_iban <> ''),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS label_rules_triple_unique ON label_rules (user_id, payer, payee, counterparty_iban)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS label_rules_label_idx ON label_rules (label_id)`
  )
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
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
    `CREATE INDEX IF NOT EXISTS transactions_user_booking_idx ON transactions (user_id, booking_date)`
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
 * The color backfill is skipped once settled per db instance (WeakSet): a
 * hot-reload creates a fresh singleton, so the check always runs when it
 * can find work, and the per-request COUNT scan only costs one boot.
 */
const colorHealSettled = new WeakSet<object>()

/**
 * Drop pre-multi-user tables (no user_id column): children first. The
 * canonical user-shaped DDL in createSchemaSqlite/migrateSchema recreates
 * them right after. Runs from both paths so a fresh singleton AND a
 * hot-reloaded one heal the file DB.
 */
function dropLegacyUserlessTables(db: Db) {
  const cols = (table: string) =>
    db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)
  const legacy = [
    "transactions",
    "label_rules",
    "categories",
    "import_batches",
    "accounts",
  ]
  const stale = legacy.filter((t) => {
    const tableCols = cols(t)
    return tableCols.length > 0 && !tableCols.includes("user_id")
  })
  if (stale.length === 0) return
  // FK enforcement cannot be toggled inside a transaction (SQLite ignores
  // the pragma there) — drops run with FKs on, so the children-first order
  // below is load-bearing. legacy is ordered children-first on purpose.
  for (const t of legacy) {
    if (cols(t).length > 0) db.run(`DROP TABLE IF EXISTS ${t}`)
  }
}

export function migrateSchema(db: Db) {
  const cols = (table: string) =>
    db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)
  // ── multi-user migration (v2.0): fresh start for everyone ────────────
  // Pre-user tables carry no user_id. Backfilling them would need an owner,
  // and the multi-user design discards single-user-era data (ADR-0032), so
  // the legacy tables are dropped wholesale and recreated with user_id by
  // the canonical DDL below. Runs in both createSchemaSqlite (fresh getDb)
  // and here (hot-reload heal) — same as the old label_rules shape check.
  dropLegacyUserlessTables(db)
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
  {
    // Allocation + backfill in one transaction: SQLite DDL is transactional,
    // so a crash mid-backfill rolls the ALTER back and the next boot re-runs
    // it. NULL rows are healed on every boot (not only when the column first
    // appears) so legacy or interrupted backfills never render the
    // collision-prone hash fallback forever.
    const hasColorCol = cols("categories").includes("color")
    if (hasColorCol && colorHealSettled.has(db)) {
      // Column exists, no NULLs possible: every insert path allocates a
      // color and the transactional backfill healed all legacy rows once.
    } else {
      const nullCount = hasColorCol
        ? (db.all<{ n: number }>(
            `SELECT COUNT(*) AS n FROM categories WHERE color IS NULL`
          )[0]?.n ?? 0)
        : 0
      if (!hasColorCol || nullCount > 0) {
        db.transaction((tx) => {
          if (!hasColorCol) {
            tx.run(`ALTER TABLE categories ADD COLUMN color TEXT`)
          }
          // Backfill deterministically (id ASC): the first categories get the
          // curated palette, later ones get procedurally generated unique
          // colors. Existing non-NULL colors count as taken.
          const existing = tx
            .all<{ id: number }>(
              `SELECT id FROM categories WHERE color IS NULL ORDER BY id ASC`
            )
            .map((r) => r.id)
          const used = tx
            .all<{ color: string | null }>(
              `SELECT color FROM categories WHERE color IS NOT NULL`
            )
            .map((r) => r.color)
            .filter((c): c is string => c !== null)
          for (const id of existing) {
            const color = pickCategoryColor(used)
            tx.run(sql`UPDATE categories SET color = ${color} WHERE id = ${id}`)
            used.push(color)
          }
        })
      }
    }
    colorHealSettled.add(db)
  }
  // Enforce color uniqueness on DBs that predate the column. SQLite ignores
  // NULLs in unique indexes, so legacy NULL backfills don't clash.
  if (
    !db
      .all<{ name: string }>(`PRAGMA index_list(categories)`)
      .some((i) => i.name === "categories_color_unique")
  ) {
    db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS categories_color_unique ON categories (color)`
    )
  }
  // ── recreate tables that the multi-user migration dropped ─────────────
  // (createSchemaSqlite would handle fresh files; migrateSchema must also
  // heal the file DB after a drop without a restart.) The legacy-shape
  // label_rules check above predates user scoping and is kept for very old
  // files. After any drop, the canonical user-shaped DDL below recreates
  // everything (idempotent); users is created first as the FK target.
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS users_issuer_subject_unique ON users (issuer, subject)`
  )
  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      iban TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS accounts_user_iban_unique ON accounts (user_id, iban)`
  )
  db.run(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      language TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'llm',
      usage_count INTEGER NOT NULL DEFAULT 0,
      color TEXT,
      created_at TEXT NOT NULL
    )
  `)
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS categories_user_name_key_unique ON categories (user_id, name_key)`
  )
  db.run(`
    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
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
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
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
    `CREATE INDEX IF NOT EXISTS transactions_user_booking_idx ON transactions (user_id, booking_date)`
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
