import { NextRequest, NextResponse } from "next/server"
import { eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { labelRules } from "@/lib/db/schema"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const labelId = Number.parseInt(id, 10)
  if (!Number.isInteger(labelId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 })
  }

  const db = getDb()
  const rules = db
    .select({
      id: labelRules.id,
      labelId: labelRules.labelId,
      iban: labelRules.iban,
      nameKey: labelRules.nameKey,
      name: labelRules.name,
      createdAt: labelRules.createdAt,
    })
    .from(labelRules)
    .where(eq(labelRules.labelId, labelId))
    .orderBy(labelRules.createdAt)
    .all()
  return NextResponse.json({ rules })
}
