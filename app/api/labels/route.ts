import { NextRequest, NextResponse } from "next/server"
import { eq, sql } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { categories } from "@/lib/db/schema"
import { normalizeCategoryKey } from "@/lib/labeller/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const db = getDb()
  const rows = db
    .select({
      id: categories.id,
      name: categories.name,
      origin: categories.origin,
      usageCount: categories.usageCount,
      ruleCount: sql<number>`(SELECT COUNT(*) FROM label_rules r WHERE r.label_id = ${categories.id})`,
    })
    .from(categories)
    .orderBy(sql`usage_count DESC, name ASC`)
    .all()
  return NextResponse.json({ labels: rows })
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    name?: unknown
  } | null
  const name = typeof body?.name === "string" ? body.name.trim() : ""
  if (!name || name.length > 64) {
    return NextResponse.json(
      { error: "invalid_name", message: "name must be 1–64 characters" },
      { status: 400 }
    )
  }

  const db = getDb()
  const nameKey = normalizeCategoryKey(name)
  const existing = db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.nameKey, nameKey))
    .get()
  if (existing) {
    return NextResponse.json(
      { error: "name_conflict", message: "label already exists" },
      { status: 409 }
    )
  }

  const inserted = db
    .insert(categories)
    .values({
      name,
      nameKey,
      language: "de",
      origin: "manual",
      usageCount: 0,
    })
    .onConflictDoNothing()
    .returning({ id: categories.id })
    .get()

  if (!inserted) {
    return NextResponse.json(
      { error: "name_conflict", message: "label already exists" },
      { status: 409 }
    )
  }
  return NextResponse.json({ id: inserted.id, name }, { status: 201 })
}
