import { NextRequest, NextResponse } from "next/server"
import { eq, sql } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { categories, transactions } from "@/lib/db/schema"
import { normalizeCategoryKey, isValidLabelName } from "@/lib/labeller/service"
import { learnRule } from "@/lib/labels/matching"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Manual label assignment: sets the category, marks the row labeled and
 * learns a counterparty rule (IBAN + normalized name → label) so future
 * transactions of this counterparty are suggested this label. Runs in one
 * transaction; the label's usageCount increments and its origin flips to
 * 'manual' (adoption = user approval). Manual assignment wins over in-flight
 * LLM claims via the attempts guard in applyLabelResults/markRowsFailed.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const body = (await request.json().catch(() => null)) as {
    labelName?: unknown
    labelId?: unknown
  } | null
  const labelName =
    typeof body?.labelName === "string" ? body.labelName.trim() : ""
  const labelIdRaw =
    typeof body?.labelId === "number" ? body.labelId : undefined
  if (!labelName && typeof labelIdRaw !== "number") {
    return NextResponse.json(
      { error: "invalid_label", message: "labelName or labelId required" },
      { status: 400 }
    )
  }

  const db = getDb()
  const row = db
    .select({
      id: transactions.id,
      payer: transactions.payer,
      payee: transactions.payee,
      type: transactions.type,
      counterpartyIban: transactions.counterpartyIban,
    })
    .from(transactions)
    .where(eq(transactions.id, id))
    .get()
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  // resolve-or-create the category
  let categoryId: number
  if (typeof labelIdRaw === "number") {
    const cat = db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, labelIdRaw))
      .get()
    if (!cat) {
      return NextResponse.json({ error: "label_not_found" }, { status: 404 })
    }
    categoryId = cat.id
  } else {
    const nameKey = normalizeCategoryKey(labelName)
    if (!nameKey || !isValidLabelName(labelName.trim())) {
      return NextResponse.json(
        {
          error: "invalid_label",
          message: "label name must be 1–64 UTF-8 bytes",
        },
        { status: 400 }
      )
    }
    const existing = db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.nameKey, nameKey))
      .get()
    if (existing) {
      categoryId = existing.id
    } else {
      const inserted = db
        .insert(categories)
        .values({
          name: labelName.trim(),
          nameKey,
          language: "de",
          origin: "manual",
          usageCount: 0,
        })
        .onConflictDoNothing()
        .returning({ id: categories.id })
        .get()
      if (!inserted) {
        const reread = db
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.nameKey, nameKey))
          .get()
        if (!reread) {
          return NextResponse.json({ error: "insert_failed" }, { status: 500 })
        }
        categoryId = reread.id
      } else {
        categoryId = inserted.id
      }
    }
  }

  const now = new Date().toISOString()
  db.transaction((tx) => {
    tx.update(transactions)
      .set({
        categoryId,
        labelStatus: "labeled",
        labelAttempts: 0,
        updatedAt: now,
      })
      .where(eq(transactions.id, id))
      .run()

    // adoption = approval: manual assignment flips the origin
    tx.update(categories)
      .set({ origin: "manual", usageCount: sql`${categories.usageCount} + 1` })
      .where(eq(categories.id, categoryId))
      .run()

    // learn rule from the counterparty this transaction is with
    const counterparty = row.type === "Ausgang" ? row.payee : row.payer
    learnRule(tx, {
      counterpartyIban: row.counterpartyIban,
      counterpartyName: counterparty,
      labelId: categoryId,
    })
  })

  return NextResponse.json({ id, labelId: categoryId })
}
