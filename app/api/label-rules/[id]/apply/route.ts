import { NextRequest, NextResponse } from "next/server"
import { eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { labelRules } from "@/lib/db/schema"
import { applyIbanRuleToTransactions } from "@/lib/labeller/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Applies a rule to existing data: matching 'Gebucht' transactions are
 * pointed at the rule's label and reset to pending so the background worker
 * re-labels them via the LLM (rule goes in as a suggestion). The reset
 * invalidates any in-flight LLM claim via the attempts-snapshot guard.
 */
export async function POST(
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
    .select({
      id: labelRules.id,
      iban: labelRules.iban,
      labelId: labelRules.labelId,
    })
    .from(labelRules)
    .where(eq(labelRules.id, ruleId))
    .get()
  if (!rule) {
    return NextResponse.json(
      { error: "not_found", message: "Regel existiert nicht" },
      { status: 404 }
    )
  }

  const affected = applyIbanRuleToTransactions(rule.iban, rule.labelId)
  if (affected === null) {
    // Label deleted between the rule read and the apply transaction (label
    // deletion cascades to rules, so the rule itself is gone too).
    return NextResponse.json(
      { error: "not_found", message: "Regel oder Label existiert nicht mehr" },
      { status: 404 }
    )
  }
  return NextResponse.json({ applied: affected.length })
}
