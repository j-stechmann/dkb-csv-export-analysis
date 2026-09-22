import { describe, it, expect, afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { getDb, resetDefaultDbForTest } from "@/lib/db"
import { resetConfigCache } from "@/lib/config"
import { seedUser } from "./helpers"
import { upsertUser, findUserById } from "@/lib/auth/users"
import * as schema from "@/lib/db/schema"

const tmpDirs: string[] = []

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** File DB with the exact v1.9.1 schema (pre-user tables, no users table). */
function createLegacyFileDb(filePath: string) {
  const sqlite = new Database(filePath)
  sqlite.pragma("journal_mode = WAL")
  sqlite.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      iban TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  sqlite.exec(`CREATE UNIQUE INDEX accounts_iban_unique ON accounts (iban)`)
  sqlite.exec(`
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
      rows_updated INTEGER NOT NULL DEFAULT 0,
      labels_total INTEGER NOT NULL DEFAULT 0,
      labels_done INTEGER NOT NULL DEFAULT 0,
      labels_failed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `)
  sqlite.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      language TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'llm',
      usage_count INTEGER NOT NULL DEFAULT 0,
      color TEXT,
      created_at TEXT NOT NULL
    )
  `)
  sqlite.exec(`
    CREATE TABLE label_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      payer TEXT NOT NULL,
      payee TEXT NOT NULL,
      counterparty_iban TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  sqlite.exec(`
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
    )
  `)
  sqlite.exec(
    `INSERT INTO accounts (iban, name, created_at) VALUES ('DE02120300000000202051', 'Legacy', '2024-01-01')`
  )
  sqlite.exec(
    `INSERT INTO categories (name, name_key, language, created_at) VALUES ('Legacy', 'legacy', 'de', '2024-01-01')`
  )
  sqlite.exec(
    `INSERT INTO transactions (id, account_id, booking_date, type, amount_cents, source_hash, created_at, updated_at) VALUES ('legacy-tx', 1, '2024-01-01', 'Ausgang', -100, 'h', '2024-01-01', '2024-01-01')`
  )
  sqlite.close()
}

function withFileDbPath(filePath: string, fn: () => void) {
  const original = process.env.DATABASE_PATH
  process.env.DATABASE_PATH = filePath
  resetConfigCache()
  resetDefaultDbForTest()
  try {
    fn()
  } finally {
    process.env.DATABASE_PATH = original
    resetConfigCache()
    resetDefaultDbForTest()
  }
}

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("multi-user migration (v2.0 fresh start)", () => {
  it("drops legacy userless tables and recreates them with user_id", () => {
    const dir = makeTmpDir("geldlage-multimig-")
    const dbPath = path.join(dir, "geldlage.db")
    createLegacyFileDb(dbPath)

    withFileDbPath(dbPath, () => {
      const db = getDb()
      // legacy rows are gone (fresh start for everyone, ADR-0032)
      expect(db.select().from(schema.accounts).all()).toHaveLength(0)
      expect(db.select().from(schema.transactions).all()).toHaveLength(0)
      expect(db.select().from(schema.categories).all()).toHaveLength(0)

      // users table exists and works
      const uid = seedUser(db)
      expect(findUserById(uid)?.subject).toBe("user-1")

      // the new tables accept rows with user_id
      db.insert(schema.accounts)
        .values({ userId: uid, iban: "DE02120300000000202051", name: "Konto" })
        .run()
      expect(db.select().from(schema.accounts).all()).toHaveLength(1)
    })

    // inspect the raw file: user_id column present, users table exists
    const raw = new Database(dbPath)
    try {
      const tables = raw
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table'`
        )
        .all()
        .map((r) => r.name)
      expect(tables).toContain("users")
      const txCols = (
        raw.pragma(`table_info(transactions)`) as { name: string }[]
      ).map((c) => c.name)
      expect(txCols).toContain("user_id")
      // per-user unique indexes swapped in
      const idx = (
        raw.pragma(`index_list(accounts)`) as { name: string }[]
      ).map((i) => i.name)
      expect(idx).toContain("accounts_user_iban_unique")
    } finally {
      raw.close()
    }
  })

  it("migration is idempotent across repeated getDb calls", () => {
    const dir = makeTmpDir("geldlage-multimig-idem-")
    const dbPath = path.join(dir, "geldlage.db")
    withFileDbPath(dbPath, () => {
      expect(() => {
        const db = getDb()
        seedUser(db)
        // second call re-runs createSchemaSqlite + migrateSchema (hot reload)
        expect(() => getDb()).not.toThrow()
        expect(() => getDb()).not.toThrow()
      }).not.toThrow()
    })
  })

  it("upsertUser provisions on first login and updates profile changes", () => {
    const first = upsertUser({
      issuer: "https://id.example.com",
      subject: "same-sub",
      name: "Initial",
      email: "initial@example.com",
    })
    const again = upsertUser({
      issuer: "https://id.example.com",
      subject: "same-sub",
      name: "Renamed",
      email: "renamed@example.com",
    })
    expect(again.id).toBe(first.id)
    expect(again.name).toBe("Renamed")
  })

  it("same subject from different issuers are distinct users", () => {
    const a = upsertUser({
      issuer: "https://a.example.com",
      subject: "sub",
      name: "A",
      email: "a@example.com",
    })
    const b = upsertUser({
      issuer: "https://b.example.com",
      subject: "sub",
      name: "B",
      email: "b@example.com",
    })
    expect(a.id).not.toBe(b.id)
  })
})
