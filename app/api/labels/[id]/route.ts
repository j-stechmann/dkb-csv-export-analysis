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

  // renaming is user approval of the wording → flips origin to manual
  db.update(categories)
    .set({ name, nameKey, origin: "manual" })
    .where(eq(categories.id, labelId))
    .run()

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
  const affectedIds = resetTransactionsForLabelDeletion(labelId)
  db.delete(categories).where(eq(categories.id, labelId)).run()

  return NextResponse.json({ affected: affectedIds.length })
}
