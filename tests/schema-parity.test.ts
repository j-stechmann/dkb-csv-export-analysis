import { describe, it, expect } from "vitest"
import { createTestDb, type Db } from "@/lib/db"
import { getTableColumns, type Table } from "drizzle-orm"
import {
  accounts,
  categories,
  importBatches,
  labelRules,
  transactions,
} from "@/lib/db/schema"

/**
 * Schema parity: the raw DDL in createSchemaSqlite (lib/db/index.ts) must
 * produce exactly the columns the drizzle schema declares. Without this
 * test the two definitions drift silently until a runtime insert error.
 */
describe("DDL ↔ drizzle schema parity", () => {
  const db: Db = createTestDb()

  function ddlColumns(table: string): string[] {
    return db
      .all<{ name: string }>(`PRAGMA table_info(${table})`)
      .map((c) => c.name)
  }

  function drizzleColumns(table: Table): string[] {
    return Object.values(getTableColumns(table)).map((c) => c.name)
  }

  it("accounts", () => {
    expect(ddlColumns("accounts").sort()).toEqual(
      drizzleColumns(accounts).sort()
    )
  })

  it("import_batches", () => {
    expect(ddlColumns("import_batches").sort()).toEqual(
      drizzleColumns(importBatches).sort()
    )
  })

  it("categories", () => {
    expect(ddlColumns("categories").sort()).toEqual(
      drizzleColumns(categories).sort()
    )
  })

  it("label_rules", () => {
    expect(ddlColumns("label_rules").sort()).toEqual(
      drizzleColumns(labelRules).sort()
    )
  })

  it("transactions", () => {
    expect(ddlColumns("transactions").sort()).toEqual(
      drizzleColumns(transactions).sort()
    )
  })
})
