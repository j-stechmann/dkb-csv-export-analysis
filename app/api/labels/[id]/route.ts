import { NextRequest, NextResponse } from "next/server"
import { eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { categories } from "@/lib/db/schema"
import {
  normalizeCategoryKey,
  resetTransactionsForLabelDeletion,
} from "@/lib/labeller/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const labelId = Number.parseInt(id, 10)
  if (!Number.isInteger(labelId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 })
  }

  const body = (await request.json().catch(() => null)) as {
    name?: unknown
  } | null
  const name = typeof body?.name === "string" ? body.name.trim() : ""
  if (!name || name.length > 64) {
    return NextResponse.json(
      { error: "invalid_name", message: "name must be 1–64 characters" },
      { status: 400 }
    )
  }

  const db = getDb()
  const current = db
    .select({ id: categories.id, nameKey: categories.nameKey })
    .from(categories)
    .where(eq(categories.id, labelId))
    .get()
  if (!current) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  const nameKey = normalizeCategoryKey(name)
  if (nameKey !== current.nameKey) {
    const clash = db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.nameKey, nameKey))
      .get()
    if (clash) {
      return NextResponse.json(
        { error: "name_conflict", message: "label name already exists" },
        { status: 409 }
      )
    }
  }

  // renaming is user approval of the wording → flips origin to manual.
  // The pre-check above is advisory only: a concurrent rename/create onto
  // the same nameKey would violate the unique index and surface as a 500,
  // so the violation is caught and reported as 409 instead.
  try {
    db.update(categories)
      .set({ name, nameKey, origin: "manual" })
      .where(eq(categories.id, labelId))
      .run()
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
      return NextResponse.json(
        { error: "name_conflict", message: "label name already exists" },
        { status: 409 }
      )
    }
    throw err
  }

  return NextResponse.json({ id: labelId, name })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const labelId = Number.parseInt(id, 10)
  if (!Number.isInteger(labelId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 })
  }

  const db = getDb()
  const current = db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.id, labelId))
    .get()
  if (!current) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }

  // 1. reset affected transactions so the worker re-labels them via the LLM
  //    (also re-points completed batches + refreshes labels_total)
  // 2. delete: rules cascade (FK ON DELETE CASCADE), FK satisfied since no
  //    transaction references the label anymore
  // Both steps run in ONE transaction: a concurrent LLM apply landing between
  // them would otherwise hit the transactions.category_id FK and 500. The
  // reset sets labelAttempts to 0, invalidating any in-flight claim, but the
  // single commit removes that window entirely.
  const affectedIds = db.transaction((tx) => {
    const ids = resetTransactionsForLabelDeletion(labelId, tx)
    tx.delete(categories).where(eq(categories.id, labelId)).run()
    return ids
  })

  return NextResponse.json({ affected: affectedIds.length })
}
