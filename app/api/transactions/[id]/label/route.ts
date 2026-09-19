import { NextRequest, NextResponse } from "next/server"
import { and, eq, sql } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { categories, transactions } from "@/lib/db/schema"
import { normalizeCategoryKey, isValidLabelName } from "@/lib/labeller/service"
import { learnRule } from "@/lib/labels/matching"
import { pickCategoryColor } from "@/lib/category-colors"
import {
  assertSameOrigin,
  requireSession,
  unauthorized,
} from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Manual label assignment: sets the category, marks the row labeled and
 * learns a rule (payer + payee + counterparty IBAN → label) so future
 * transactions matching all three exactly are suggested this label. Runs in
 * one transaction; the label's usageCount increments and its origin flips to
 * 'manual' (adoption = user approval). Manual assignment wins over in-flight
 * LLM claims via the attempts guard in applyLabelResults/markRowsFailed.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
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
      userId: transactions.userId,
      payer: transactions.payer,
      payee: transactions.payee,
      counterpartyIban: transactions.counterpartyIban,
    })
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, session.uid)))
    .get()
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  // resolve-or-create the category (per-user namespace)
  let categoryId: number
  if (typeof labelIdRaw === "number") {
    const cat = db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(eq(categories.id, labelIdRaw), eq(categories.userId, session.uid))
      )
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
          message:
            "label name must be 1–64 UTF-8 bytes and free of | < > index= markers",
        },
        { status: 400 }
      )
    }
    const existing = db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(eq(categories.userId, session.uid), eq(categories.nameKey, nameKey))
      )
      .get()
    if (existing) {
      categoryId = existing.id
    } else {
      // Allocation + insert in one transaction so concurrent creates can't
      // pick the same color (the unique index is the last line of defense).
      const inserted = db.transaction((tx) => {
        const used = tx
          .select({ color: categories.color })
          .from(categories)
          .all()
          .map((r) => r.color)
          .filter((c): c is string => c !== null)
        return tx
          .insert(categories)
          .values({
            userId: session.uid,
            name: labelName.trim(),
            nameKey,
            language: "de",
            origin: "manual",
            usageCount: 0,
            color: pickCategoryColor(used),
          })
          .onConflictDoNothing()
          .returning({ id: categories.id })
          .get()
      })
      if (!inserted) {
        const reread = db
          .select({ id: categories.id })
          .from(categories)
          .where(
            and(
              eq(categories.userId, session.uid),
              eq(categories.nameKey, nameKey)
            )
          )
          .get()
        if (!reread) {
          return NextResponse.json(
            { error: "insert_failed", message: "could not create label" },
            { status: 500 }
          )
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
      .where(and(eq(transactions.id, id), eq(transactions.userId, session.uid)))
      .run()

    // adoption = approval: manual assignment flips the origin
    tx.update(categories)
      .set({ origin: "manual", usageCount: sql`${categories.usageCount} + 1` })
      .where(
        and(eq(categories.id, categoryId), eq(categories.userId, session.uid))
      )
      .run()

    // learn rule from this transaction's payer/payee/IBAN verbatim
    // (learnRule rejects rows missing any of the three)
    learnRule(tx, {
      userId: session.uid,
      payer: row.payer,
      payee: row.payee,
      counterpartyIban: row.counterpartyIban,
      labelId: categoryId,
    })
  })

  return NextResponse.json({ id, labelId: categoryId })
}
