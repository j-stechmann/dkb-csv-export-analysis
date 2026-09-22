import { describe, it, expect, afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { getDb, resetDefaultDbForTest, type Db } from "@/lib/db"
import { resetConfigCache } from "@/lib/config"

let tmpDir: string | null = null
const tmpDirs: string[] = []
let db: Db | null = null

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
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

function rawConnection(filePath: string): Database.Database {
  return new Database(filePath)
}

afterAll(() => {
  db?.$client.close()
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs.length = 0
  tmpDir = null
})

describe("legacy dkb.db adoption (rebrand file rename)", () => {
  it("renames an existing dkb.db into the configured path with its data", () => {
    tmpDir = makeTmpDir("geldlage-legacy-adopt-")
    const dbPath = path.join(tmpDir, "geldlage.db")
    const legacyPath = path.join(tmpDir, "dkb.db")

    const sqlite = new Database(legacyPath)
    sqlite.exec(`CREATE TABLE marker (v TEXT)`)
    sqlite.exec(`INSERT INTO marker VALUES ('kept')`)
    sqlite.close()

    withFileDbPath(dbPath, () => {
      db = getDb()
      expect(db.all(`SELECT v FROM marker`).length).toBe(1)
    })

    expect(fs.existsSync(legacyPath)).toBe(false)
    expect(fs.existsSync(dbPath)).toBe(true)
    const raw = rawConnection(dbPath)
    try {
      expect(raw.prepare(`SELECT v FROM marker`).get()).toEqual({ v: "kept" })
    } finally {
      raw.close()
    }
  })

  it("moves WAL sidecars along with the main file", () => {
    tmpDir = makeTmpDir("geldlage-legacy-wal-")
    const dbPath = path.join(tmpDir, "geldlage.db")
    const legacyPath = path.join(tmpDir, "dkb.db")

    const sqlite = new Database(legacyPath)
    sqlite.pragma("journal_mode = WAL")
    sqlite.exec(`CREATE TABLE marker (v TEXT)`)
    sqlite.exec(`INSERT INTO marker VALUES ('wal')`)
    sqlite.close()
    // closing checkpoints and removes the sidecars; fake their presence
    for (const suffix of ["-wal", "-shm"]) {
      fs.writeFileSync(legacyPath + suffix, "x")
    }

    withFileDbPath(dbPath, () => {
      db = getDb()
      expect(db.all(`SELECT v FROM marker`).length).toBe(1)
      // while open: renamed sidecars exist (closing checkpoints/removes them)
      expect(fs.existsSync(legacyPath)).toBe(false)
      expect(fs.existsSync(legacyPath + "-wal")).toBe(false)
      expect(fs.existsSync(legacyPath + "-shm")).toBe(false)
      expect(fs.existsSync(dbPath + "-wal")).toBe(true)
      expect(fs.existsSync(dbPath + "-shm")).toBe(true)
    })
  })

  it("never overwrites an existing target DB", () => {
    tmpDir = makeTmpDir("geldlage-legacy-keep-")
    const dbPath = path.join(tmpDir, "geldlage.db")
    const legacyPath = path.join(tmpDir, "dkb.db")

    const target = new Database(dbPath)
    target.exec(`CREATE TABLE marker (v TEXT)`)
    target.exec(`INSERT INTO marker VALUES ('target')`)
    target.close()
    const legacy = new Database(legacyPath)
    legacy.exec(`CREATE TABLE marker (v TEXT)`)
    legacy.exec(`INSERT INTO marker VALUES ('legacy')`)
    legacy.close()

    withFileDbPath(dbPath, () => {
      db = getDb()
      expect(db.all(`SELECT v FROM marker`)).toEqual([{ v: "target" }])
    })

    expect(fs.existsSync(legacyPath)).toBe(true)
  })

  it("does nothing when no legacy file exists", () => {
    tmpDir = makeTmpDir("geldlage-legacy-none-")
    const dbPath = path.join(tmpDir, "geldlage.db")

    withFileDbPath(dbPath, () => {
      db = getDb()
      expect(
        db.all(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      ).toHaveLength(7)
    })

    expect(fs.existsSync(dbPath)).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, "dkb.db"))).toBe(false)
  })

  it("skips adoption for :memory: paths", () => {
    withFileDbPath(":memory:", () => {
      expect(() => {
        db = getDb()
      }).not.toThrow()
    })
  })
})
