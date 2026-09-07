import { NextRequest, NextResponse } from "next/server"
import { applyIbanRuleToTransactions } from "@/lib/labeller/service"
import { parseIdParam } from "@/lib/api/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Applies a rule to existing data: matching 'Gebucht' transactions are
 * pointed at the rule's label and reset to pending so the background worker
 * re-labels them via the LLM (rule goes in as a suggestion). The rule and
 * label are re-read inside the apply transaction, so concurrent edits to
 * either cannot produce a stale apply.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const ruleId = parseIdParam(id)
  if (ruleId === null) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 })
  }

  const affected = applyIbanRuleToTransactions(ruleId)
  if (affected === null) {
    // Rule or its label deleted concurrently
    return NextResponse.json(
      { error: "not_found", message: "Regel oder Label existiert nicht mehr" },
      { status: 404 }
    )
  }
  return NextResponse.json({ applied: affected.length })
}
