import fs from "node:fs"
import path from "node:path"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/better-sqlite3"
import Database from "better-sqlite3"
import * as schema from "./schema"
import { getConfig } from "@/lib/config"
import {
  counterpartyDisplayName,
  normalizeCounterpartyKey,
} from "@/lib/db/normalize"

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
  // migrateSchema (not part of the fresh-DB path) is what creates the tuple
  // unique index — run it so tests exercise the real constraints
  migrateSchema(db)
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
      payer_key TEXT NOT NULL DEFAULT '',
      payee_key TEXT NOT NULL DEFAULT '',
      payer TEXT NOT NULL DEFAULT '',
      payee TEXT NOT NULL DEFAULT '',
      name_key TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  // NOTE: the tuple unique index is NOT created here — on a legacy DB this
  // CREATE TABLE is a no-op and the payer_key/payee_key columns only come
  // into existence via migrateLabelRules. migrateLabelRules creates the
  // index after the columns (and the backfill) exist.
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
      payer_key TEXT NOT NULL DEFAULT '',
      payee_key TEXT NOT NULL DEFAULT '',
      payer TEXT NOT NULL DEFAULT '',
      payee TEXT NOT NULL DEFAULT '',
      name_key TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  migrateLabelRules(db)
  db.run(
    `CREATE INDEX IF NOT EXISTS label_rules_iban_idx ON label_rules (iban)`
  )
  db.run(
    `CREATE INDEX IF NOT EXISTS label_rules_label_idx ON label_rules (label_id)`
  )
}

/**
 * Tuple-identity migration for label_rules: rules were keyed on
 * (iban, name_key) and matched transactions by IBAN alone; they are now
 * keyed on (iban, payer_key, payee_key) and match the exact combination.
 * Steps, all idempotent and re-runnable after a crash at any point:
 * 1. add payer_key/payee_key + display snapshot columns when missing
 * 2. merge legacy siblings that normalize onto the same tuple (newest wins)
 * 3. backfill tuple keys from transaction evidence (legacy name_key → the
 *    direction-counterparty's payer/payee of a matching transaction);
 *    fallback payee_key = name_key, payer_key = '' (inert until edited)
 * 4. drop the legacy (iban, name_key) unique index, create the tuple index.
 * Steps 3/4 are guarded independently so a crash between them heals on the
 * next migrateSchema run.
 */
function migrateLabelRules(db: Db) {
  const cols = (table: string) =>
    db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)
  const ruleCols = cols("label_rules")

  if (!ruleCols.includes("payer_key")) {
    db.run(
      `ALTER TABLE label_rules ADD COLUMN payer_key TEXT NOT NULL DEFAULT ''`
    )
  }
  if (!ruleCols.includes("payee_key")) {
    db.run(
      `ALTER TABLE label_rules ADD COLUMN payee_key TEXT NOT NULL DEFAULT ''`
    )
  }
  if (!ruleCols.includes("payer")) {
    db.run(`ALTER TABLE label_rules ADD COLUMN payer TEXT NOT NULL DEFAULT ''`)
  }
  if (!ruleCols.includes("payee")) {
    db.run(`ALTER TABLE label_rules ADD COLUMN payee TEXT NOT NULL DEFAULT ''`)
  }

  // legacy rows are those that never went through tuple backfill
  const hasLegacyRows = db.get<{ x: number }>(
    sql`SELECT 1 AS x FROM label_rules
        WHERE payer_key = '' AND payee_key = '' AND name_key != '' LIMIT 1`
  )
  if (hasLegacyRows?.x) {
    mergeLegacyTuples(db)
    backfillLegacyTuples(db)
  }

  // index swap must be independent of the row guard: a crash between
  // backfill and index creation must not leave the tuple key non-unique
  const indexes = db
    .all<{ name: string }>(`PRAGMA index_list(label_rules)`)
    .map((i) => i.name)
  if (indexes.includes("label_rules_iban_name_key_unique")) {
    db.run(`DROP INDEX label_rules_iban_name_key_unique`)
  }
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS label_rules_iban_payer_payee_unique ON label_rules (iban, payer_key, payee_key)`
  )
}

/**
 * Defensive pre-pass before backfill: collapses legacy rows sharing an IBAN
 * whose name_keys normalize to the same key, keeping the newest per group
 * (the same "re-assignment wins" semantics learnRule applies). For data
 * written by the old learnRule this is a no-op — name_keys were stored
 * pre-normalized and the legacy unique index forbade identical (iban,
 * name_key) siblings — but hand-edited or tool-written rows could differ.
 */
function mergeLegacyTuples(db: Db) {
  // legacy rows grouped by the normalized form of their name_key; keep
  // newest (MAX id) per (iban, normalized name_key)
  const rules = db.all<{ id: number; iban: string; name_key: string }>(
    sql`SELECT id, iban, name_key FROM label_rules
          WHERE payer_key = '' AND payee_key = '' AND name_key != ''
          ORDER BY id DESC`
  )
  const keep = new Map<string, number>()
  const drop: number[] = []
  for (const r of rules) {
    const key = `${r.iban}\u0000${normalizeCounterpartyKey(r.name_key)}`
    if (!keep.has(key)) keep.set(key, r.id)
    else drop.push(r.id)
  }
  for (const id of drop) {
    db.run(sql`DELETE FROM label_rules WHERE id = ${id}`)
  }
}

/**
 * Backfills payer_key/payee_key (+ display snapshots) for legacy rows:
 * looks for a transaction on the rule's IBAN whose direction-counterparty
 * normalizes to the rule's name_key and adopts that transaction's full
 * (payer, payee) rendering. Without evidence the rule keeps name_key as
 * payee_key (payer_key '' = never matches — inert until edited or re-learned
 * by the next manual assignment). Candidates are ordered deterministically
 * (lexicographic) so repeated runs pick the same evidence.
 */
function backfillLegacyTuples(db: Db) {
  const rules = db
    .all<{
      id: number
      iban: string
      name_key: string
      name: string
    }>(
      sql`SELECT id, iban, name_key, name FROM label_rules
          WHERE payer_key = '' AND payee_key = '' AND name_key != ''`
    )
    .map((r) => ({ ...r, nameKey: normalizeCounterpartyKey(r.name_key) }))
  // tuples already taken by non-legacy (e.g. previously backfilled) rules on
  // the same iban — adopting them again would violate the unique index and
  // deterministically re-throw on every getDb() call
  const takenTuples = new Set(
    (
      db.all<{ iban: string; payer_key: string; payee_key: string }>(
        sql`SELECT iban, payer_key, payee_key FROM label_rules
            WHERE NOT (payer_key = '' AND payee_key = '' AND name_key != '')`
      ) as unknown as {
        iban: string
        payer_key: string
        payee_key: string
      }[]
    ).map((r) => `${r.iban}\u0000${r.payer_key}\u0000${r.payee_key}`)
  )
  for (const rule of rules) {
    // same prefilter idiom as findIbanRuleMatches: SQL strips spaces/case,
    // the exact normalized comparison happens TS-side
    const candidates = db.all<{
      type: string
      payer: string | null
      payee: string | null
    }>(
      sql`SELECT DISTINCT type, payer, payee FROM transactions
          WHERE status = 'Gebucht'
            AND UPPER(REPLACE(counterparty_iban, ' ', '')) = ${rule.iban}
          ORDER BY payee DESC, payer DESC`
    )
    const match = candidates.find((c) => {
      const counterparty = c.type === "Ausgang" ? c.payee : c.payer
      if (counterparty === null) return false
      if (normalizeCounterpartyKey(counterparty) !== rule.nameKey) return false
      // skip evidence whose full tuple is already claimed by another rule
      // (e.g. a payment and its reversal stored with identical parties):
      // fall through to the inert fallback instead of colliding on UPDATE
      const tuple = `${rule.iban}\u0000${normalizeCounterpartyKey(c.payer)}\u0000${normalizeCounterpartyKey(c.payee)}`
      return !takenTuples.has(tuple)
    })
    if (match) {
      const payerKey = normalizeCounterpartyKey(match.payer)
      const payeeKey = normalizeCounterpartyKey(match.payee)
      db.run(
        sql`UPDATE label_rules SET payer_key = ${payerKey},
            payee_key = ${payeeKey},
            payer = ${counterpartyDisplayName(match.payer)},
            payee = ${counterpartyDisplayName(match.payee)}
            WHERE id = ${rule.id}`
      )
      takenTuples.add(`${rule.iban}\u0000${payerKey}\u0000${payeeKey}`)
    } else {
      db.run(
        sql`UPDATE label_rules SET payee_key = ${rule.nameKey},
            payee = ${counterpartyDisplayName(rule.name)}
            WHERE id = ${rule.id}`
      )
      takenTuples.add(`${rule.iban}\u0000\u0000${rule.nameKey}`)
    }
  }
}
