import { NextRequest, NextResponse } from "next/server"
import { and, eq, ne } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { categories, labelRules } from "@/lib/db/schema"
import {
  counterpartyDisplayName,
  isLearnableIbanKey,
  normalizeCounterpartyKey,
  normalizeIbanKey,
} from "@/lib/db/normalize"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Edits a learned rule: target label, counterparty IBAN and display name.
 * Keys are normalized the same way learning normalizes them; a name change
 * re-derives the nameKey so the rule stays consistent with future learning.
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
    iban?: unknown
    name?: unknown
  } | null
  if (
    typeof body?.labelId !== "number" ||
    !Number.isInteger(body.labelId) ||
    typeof body?.iban !== "string" ||
    typeof body?.name !== "string"
  ) {
    return NextResponse.json(
      { error: "invalid_body", message: "labelId, iban and name are required" },
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

  const ibanKey = normalizeIbanKey(body.iban)
  if (!ibanKey || !isLearnableIbanKey(ibanKey)) {
    return NextResponse.json(
      {
        error: "invalid_iban",
        message: "IBAN zu kurz oder nicht erkennbar",
      },
      { status: 400 }
    )
  }

  const name = counterpartyDisplayName(body.name)
  const nameKey = normalizeCounterpartyKey(body.name)
  if (!name || !nameKey) {
    return NextResponse.json(
      {
        error: "invalid_name",
        message: "Name darf nicht leer sein",
      },
      { status: 400 }
    )
  }

  // advisory pre-check excluding the rule itself (editing only the display
  // name must not self-conflict) — the try/catch below covers the race.
  const clash = db
    .select({ id: labelRules.id })
    .from(labelRules)
    .where(
      and(
        eq(labelRules.iban, ibanKey),
        eq(labelRules.nameKey, nameKey),
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
        iban: ibanKey,
        nameKey,
        name,
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
      iban: labelRules.iban,
      nameKey: labelRules.nameKey,
      name: labelRules.name,
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
