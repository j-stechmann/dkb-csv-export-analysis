import { NextRequest, NextResponse } from "next/server"
import { eq, sql } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { categories } from "@/lib/db/schema"
import { normalizeCategoryKey, isValidLabelName } from "@/lib/labeller/service"
import { getConfig } from "@/lib/config"
import { parseBody, LabelCreateSchema } from "@/lib/api/schemas"
import { badRequest, conflict } from "@/lib/api/http"

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
  const body = await parseBody(LabelCreateSchema, request)
  const name = body?.name ?? ""
  if (!body || !isValidLabelName(name)) {
    return badRequest(
      "invalid_name",
      "Label-Name: 1–64 UTF-8 Bytes, ohne | < > index= Marker"
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
    return conflict("name_conflict", "Label existiert bereits")
  }

  const inserted = db
    .insert(categories)
    .values({
      name,
      nameKey,
      language: getConfig().LLM_LANGUAGE,
      origin: "manual",
      usageCount: 0,
    })
    .onConflictDoNothing()
    .returning({ id: categories.id })
    .get()

  if (!inserted) {
    return conflict("name_conflict", "Label existiert bereits")
  }
  return NextResponse.json({ id: inserted.id, name }, { status: 201 })
}
