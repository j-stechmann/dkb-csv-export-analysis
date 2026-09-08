import { NextRequest, NextResponse } from "next/server"
import { and, eq, ne } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { categories, labelRules } from "@/lib/db/schema"
import { normalizeWhitespace } from "@/lib/money"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Edits a learned rule: target label, payer, payee and counterparty IBAN.
 * All three key fields are required and whitespace-normalized (via the same
 * normalizeWhitespace the CSV parser uses), so stored values match the
 * cleanCell'd transaction columns exactly; a rule must never carry null or
 * empty components.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const ruleId = Number.parseInt(id, 10)
  if (!Number.isInteger(ruleId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 })
  }

  const body = (await request.json().catch(() => null)) as {
    labelId?: unknown
    payer?: unknown
    payee?: unknown
    counterpartyIban?: unknown
  } | null
  if (
    typeof body?.labelId !== "number" ||
    !Number.isInteger(body.labelId) ||
    typeof body?.payer !== "string" ||
    typeof body?.payee !== "string" ||
    typeof body?.counterpartyIban !== "string"
  ) {
    return NextResponse.json(
      {
        error: "invalid_body",
        message: "labelId, payer, payee and counterpartyIban are required",
      },
      { status: 400 }
    )
  }

  const payer = normalizeWhitespace(body.payer)
  const payee = normalizeWhitespace(body.payee)
  const counterpartyIban = normalizeWhitespace(body.counterpartyIban)
  if (payer === "" || payee === "" || counterpartyIban === "") {
    return NextResponse.json(
      {
        error: "invalid_body",
        message: "payer, payee and counterpartyIban must not be empty",
      },
      { status: 400 }
    )
  }

  const db = getDb()
  const current = db
    .select({ id: labelRules.id })
    .from(labelRules)
    .where(eq(labelRules.id, ruleId))
    .get()
  if (!current) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  const targetLabel = db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.id, body.labelId))
    .get()
  if (!targetLabel) {
    return NextResponse.json(
      { error: "label_not_found", message: "Label existiert nicht" },
      { status: 404 }
    )
  }

  // advisory pre-check excluding the rule itself — the try/catch below
  // covers the race.
  const clash = db
    .select({ id: labelRules.id })
    .from(labelRules)
    .where(
      and(
        eq(labelRules.payer, payer),
        eq(labelRules.payee, payee),
        eq(labelRules.counterpartyIban, counterpartyIban),
        ne(labelRules.id, ruleId)
      )
    )
    .get()
  if (clash) {
    return NextResponse.json(
      { error: "rule_conflict", message: "Regel existiert bereits" },
      { status: 409 }
    )
  }

  const now = new Date().toISOString()
  try {
    db.update(labelRules)
      .set({
        labelId: body.labelId,
        payer,
        payee,
        counterpartyIban,
        updatedAt: now,
      })
      .where(eq(labelRules.id, ruleId))
      .run()
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
      return NextResponse.json(
        { error: "rule_conflict", message: "Regel existiert bereits" },
        { status: 409 }
      )
    }
    throw err
  }

  const updated = db
    .select({
      id: labelRules.id,
      labelId: labelRules.labelId,
      payer: labelRules.payer,
      payee: labelRules.payee,
      counterpartyIban: labelRules.counterpartyIban,
    })
    .from(labelRules)
    .where(eq(labelRules.id, ruleId))
    .get()
  return NextResponse.json({ rule: updated })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const ruleId = Number.parseInt(id, 10)
  if (!Number.isInteger(ruleId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 })
  }

  const db = getDb()
  const result = db.delete(labelRules).where(eq(labelRules.id, ruleId)).run()
  if (result.changes === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  return NextResponse.json({ deleted: result.changes })
}
