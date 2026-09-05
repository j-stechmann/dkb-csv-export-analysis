import { NextRequest, NextResponse } from "next/server"
import { eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { labelRules } from "@/lib/db/schema"
import { findIbanRuleMatches } from "@/lib/labeller/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Count of labelable transactions the rule would apply to. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const ruleId = Number.parseInt(id, 10)
  if (!Number.isInteger(ruleId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 })
  }

  const db = getDb()
  const rule = db
    .select({ id: labelRules.id, iban: labelRules.iban })
    .from(labelRules)
    .where(eq(labelRules.id, ruleId))
    .get()
  if (!rule) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  return NextResponse.json({ count: findIbanRuleMatches(db, rule.iban).length })
}
