import { NextRequest, NextResponse } from "next/server"
import { asc, count, desc, eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { categories, labelRules } from "@/lib/db/schema"
import { normalizeCategoryKey, isValidLabelName } from "@/lib/labeller/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const db = getDb()
  // count(labelRules.id) — NOT count(): COUNT(*) after the LEFT JOIN would
  // report 1 for every label without rules.
  const rows = db
    .select({
      id: categories.id,
      name: categories.name,
      origin: categories.origin,
      usageCount: categories.usageCount,
      ruleCount: count(labelRules.id),
    })
    .from(categories)
    .leftJoin(labelRules, eq(labelRules.labelId, categories.id))
    .groupBy(categories.id)
    .orderBy(desc(categories.usageCount), asc(categories.name))
    .all()
  return NextResponse.json({ labels: rows })
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    name?: unknown
  } | null
  const name = typeof body?.name === "string" ? body.name.trim() : ""
  if (!isValidLabelName(name)) {
    return NextResponse.json(
      {
        error: "invalid_name",
        message:
          "name must be 1–64 UTF-8 bytes and free of | < > index= markers",
      },
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
