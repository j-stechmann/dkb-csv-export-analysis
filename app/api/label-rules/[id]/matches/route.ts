import { NextRequest, NextResponse } from "next/server"
import { and, eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { labelRules } from "@/lib/db/schema"
import { findRuleMatches } from "@/lib/labeller/service"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Count of labelable transactions the rule would apply to. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const { id } = await params
  const ruleId = Number.parseInt(id, 10)
  if (!Number.isInteger(ruleId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 })
  }

  const db = getDb()
  const rule = db
    .select({
      id: labelRules.id,
      userId: labelRules.userId,
      payer: labelRules.payer,
      payee: labelRules.payee,
      counterpartyIban: labelRules.counterpartyIban,
      labelId: labelRules.labelId,
    })
    .from(labelRules)
    .where(and(eq(labelRules.id, ruleId), eq(labelRules.userId, session.uid)))
    .get()
  if (!rule) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  // Same exclusion as apply, so the preview count matches what applying
  // would actually reset (rows already at the rule's label are skipped).
  return NextResponse.json({
    count: findRuleMatches(
      db,
      rule.userId,
      rule.payer,
      rule.payee,
      rule.counterpartyIban,
      rule.labelId
    ).length,
  })
}
