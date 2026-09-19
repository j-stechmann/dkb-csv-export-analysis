import { NextRequest, NextResponse } from "next/server"
import { and, eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { categories, labelRules } from "@/lib/db/schema"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const { id } = await params
  const labelId = Number.parseInt(id, 10)
  if (!Number.isInteger(labelId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 })
  }

  const db = getDb()
  const label = db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, labelId), eq(categories.userId, session.uid)))
    .get()
  if (!label) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  const rules = db
    .select({
      id: labelRules.id,
      labelId: labelRules.labelId,
      payer: labelRules.payer,
      payee: labelRules.payee,
      counterpartyIban: labelRules.counterpartyIban,
      createdAt: labelRules.createdAt,
    })
    .from(labelRules)
    .where(
      and(eq(labelRules.labelId, labelId), eq(labelRules.userId, session.uid))
    )
    .orderBy(labelRules.createdAt)
    .all()
  return NextResponse.json({ rules })
}
