import { describe, it, expect, afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import * as schema from "@/lib/db/schema"
import { getDb, resetDefaultDbForTest, type Db } from "@/lib/db"
import { resetConfigCache } from "@/lib/config"
import { resolveAndUseCategory } from "@/lib/labeller/service"
import { eq } from "drizzle-orm"

let tmpDir: string | null = null
const tmpDirs: string[] = []
let db: Db | null = null

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

// DDL of the previous release: label_rules keyed on (iban, name_key).
const OLD_LABEL_RULES_DDL = `
  CREATE TABLE label_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    iban TEXT NOT NULL,
    name_key TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`

function createOldShapeFileDb(filePath: string) {
  const sqlite = new Database(filePath)
  sqlite.pragma("journal_mode = WAL")
  sqlite.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      language TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)
  sqlite.exec(OLD_LABEL_RULES_DDL)
  sqlite.exec(
    `CREATE UNIQUE INDEX label_rules_iban_name_key_unique ON label_rules (iban, name_key)`
  )
  sqlite.close()
}

function createPreColorFileDb(filePath: string) {
  const sqlite = new Database(filePath)
  sqlite.pragma("journal_mode = WAL")
  sqlite.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      language TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'llm',
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `)
  sqlite.exec(
    `CREATE UNIQUE INDEX categories_name_key_unique ON categories (name_key)`
  )
  sqlite.exec(`
    INSERT INTO categories (name, name_key, language, created_at) VALUES
      ('A', 'a', 'de', '2024-01-01T00:00:00.000Z'),
      ('B', 'b', 'de', '2024-01-01T00:00:00.000Z'),
      ('C', 'c', 'de', '2024-01-01T00:00:00.000Z')
  `)
  sqlite.close()
}

function withFileDbPath(filePath: string, fn: () => void) {
  const original = process.env.DATABASE_PATH
  process.env.DATABASE_PATH = filePath
  resetConfigCache()
  resetDefaultDbForTest()
  db = null
  try {
    fn()
  } finally {
    ;(db as Db | null)?.$client.close()
    db = null
    process.env.DATABASE_PATH = original
    resetConfigCache()
    resetDefaultDbForTest()
  }
}

function rawConnection(): Database.Database {
  return new Database(path.join(tmpDir!, "dkb.db"))
}

afterAll(() => {
  db?.$client.close()
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs.length = 0
  tmpDir = null
})

describe("file DB migration: color column backfill", () => {
  it("adds color, backfills unique colors, and enforces uniqueness", () => {
    tmpDir = makeTmpDir("dkb-color-migration-")
    const dbPath = path.join(tmpDir, "dkb.db")
    createPreColorFileDb(dbPath)

    withFileDbPath(dbPath, () => {
      db = getDb()
      // backfilled colors exist, are unique, and the new-label path works
      const cats = db.select().from(schema.categories).all()
      const colors = cats.map((c) => c.color)
      expect(colors).not.toContain(null)
      expect(new Set(colors).size).toBe(colors.length)

      // new categories get a color via the allocation choke point
      const newId = db.transaction((tx) => resolveAndUseCategory(tx, "D"))
      expect(newId).not.toBeNull()
      const inserted = db
        .select()
        .from(schema.categories)
        .where(eq(schema.categories.id, newId!))
        .get()
      expect(inserted?.color).not.toBeNull()
      expect(colors).not.toContain(inserted?.color)
    })

    const raw = rawConnection()
    try {
      const catCols = (
        raw.pragma(`table_info(categories)`) as { name: string }[]
      ).map((c) => c.name)
      expect(catCols).toContain("color")
      const indexes = (
        raw.pragma(`index_list(categories)`) as { name: string }[]
      ).map((i) => i.name)
      expect(indexes).toContain("categories_color_unique")
      // backfill order is deterministic (id ASC → curated palette first)
      const ids = raw
        .prepare<[], { id: number; color: string | null }>(
          `SELECT id, color FROM categories ORDER BY id ASC`
        )
        .all()
      expect(ids[0].color).not.toBe(ids[1].color)
      expect(ids[1].color).not.toBe(ids[2].color)
    } finally {
      raw.close()
    }
  })

  it("violating the color unique index throws", () => {
    tmpDir = makeTmpDir("dkb-color-unique-")
    const dbPath = path.join(tmpDir, "dkb.db")

    withFileDbPath(dbPath, () => {
      db = getDb()
      db.insert(schema.categories)
        .values({
          name: "A",
          nameKey: "a",
          language: "de",
          origin: "llm",
          color: "oklch(0.62 0.17 250)",
          createdAt: new Date().toISOString(),
        })
        .run()
      expect(() =>
        db!
          .insert(schema.categories)
          .values({
            name: "B",
            nameKey: "b",
            language: "de",
            origin: "llm",
            color: "oklch(0.62 0.17 250)",
            createdAt: new Date().toISOString(),
          })
          .run()
      ).toThrow(/UNIQUE/)
    })
  })
})

describe("file DB migration: old (iban, name_key) label_rules shape", () => {
  it("getDb() drops and rebuilds label_rules instead of crashing", () => {
    tmpDir = makeTmpDir("dkb-migration-")
    createOldShapeFileDb(path.join(tmpDir, "dkb.db"))

    withFileDbPath(path.join(tmpDir, "dkb.db"), () => {
      expect(() => {
        db = getDb()
      }).not.toThrow()
    })

    const raw = rawConnection()
    try {
      const ruleCols = (
        raw.pragma(`table_info(label_rules)`) as { name: string }[]
      ).map((c) => c.name)
      expect(ruleCols).toContain("payer")
      expect(ruleCols).toContain("payee")
      expect(ruleCols).toContain("counterparty_iban")
      expect(ruleCols).not.toContain("iban")
      expect(ruleCols).not.toContain("name_key")

      const indexes = (
        raw.pragma(`index_list(label_rules)`) as { name: string }[]
      ).map((i) => i.name)
      expect(indexes).toContain("label_rules_triple_unique")

      const n = raw
        .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM label_rules`)
        .get()!.n
      expect(n).toBe(0)
    } finally {
      raw.close()
    }
  })

  it("rebuilt table enforces the triple unique index", () => {
    tmpDir = makeTmpDir("dkb-migration-")
    const dbPath = path.join(tmpDir, "dkb.db")
    createOldShapeFileDb(dbPath)

    withFileDbPath(dbPath, () => {
      db = getDb()
      db.insert(schema.categories)
        .values({
          name: "Groceries",
          nameKey: "groceries",
          language: "de",
          origin: "llm",
          createdAt: new Date().toISOString(),
        })
        .run()
      const rule = {
        labelId: 1,
        payer: "P",
        payee: "Q",
        counterpartyIban: "DE02120300000000202051",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      db.insert(schema.labelRules).values(rule).run()
      expect(() => db!.insert(schema.labelRules).values(rule).run()).toThrow(
        /UNIQUE/
      )
    })
  })

  it("fresh (empty) file DB still creates the full schema via getDb()", () => {
    tmpDir = makeTmpDir("dkb-fresh-")
    const dbPath = path.join(tmpDir, "fresh.db")

    withFileDbPath(dbPath, () => {
      expect(() => {
        db = getDb()
      }).not.toThrow()
    })

    const raw = new Database(dbPath)
    try {
      const tables = raw
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table'`
        )
        .all()
        .map((r) => r.name)
      for (const expected of [
        "accounts",
        "import_batches",
        "categories",
        "label_rules",
        "transactions",
      ]) {
        expect(tables).toContain(expected)
      }
    } finally {
      raw.close()
    }
  })
})
