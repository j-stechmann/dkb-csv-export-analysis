import { NextRequest, NextResponse } from "next/server"
import { and, eq, sql } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { categories } from "@/lib/db/schema"
import { normalizeCategoryKey, isValidLabelName } from "@/lib/labeller/service"
import { pickCategoryColor } from "@/lib/category-colors"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const db = getDb()
  const rows = db
    .select({
      id: categories.id,
      name: categories.name,
      origin: categories.origin,
      usageCount: categories.usageCount,
      color: categories.color,
      // Table-qualified reference: drizzle renders ${categories.id} as
      // unqualified "id" in a single-table select, and inside the subquery
      // scope SQLite resolves it to the inner label_rules.id — yielding
      // counts only where a rule's row id coincidentally equals the label id
      // (usually 0, always wrong).
      ruleCount: sql<number>`(SELECT COUNT(*) FROM label_rules r WHERE r.label_id = categories.id)`,
    })
    .from(categories)
    .where(eq(categories.userId, session.uid))
    .orderBy(sql`usage_count DESC, name ASC`)
    .all()
  return NextResponse.json({ labels: rows })
}

export async function POST(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const body = (await request.json().catch(() => null)) as {
    name?: unknown
  } | null
  const name = typeof body?.name === "string" ? body.name.trim() : ""
  if (!isValidLabelName(name)) {
    return NextResponse.json(
      {
        error: "invalid_name",
        message:
          "name must be 1–64 UTF-8 bytes and free of | < > index= markers",
      },
      { status: 400 }
    )
  }

  const db = getDb()
  const nameKey = normalizeCategoryKey(name)
  const existing = db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(eq(categories.userId, session.uid), eq(categories.nameKey, nameKey))
    )
    .get()
  if (existing) {
    return NextResponse.json(
      { error: "name_conflict", message: "label already exists" },
      { status: 409 }
    )
  }

  // Allocation + insert in one transaction so two concurrent creates can't
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
        name,
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
    // onConflictDoNothing doesn't say which index fired: reread by nameKey to
    // distinguish a concurrent same-name create (409) from a color-allocation
    // collision the unique index caught (500; unreachable with the fully
    // synchronous single-process driver, defended against anyway).
    const reread = db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(eq(categories.userId, session.uid), eq(categories.nameKey, nameKey))
      )
      .get()
    if (!reread) {
      return NextResponse.json(
        { error: "insert_failed", message: "could not create label" },
        { status: 500 }
      )
    }
    return NextResponse.json(
      { error: "name_conflict", message: "label already exists" },
      { status: 409 }
    )
  }
  return NextResponse.json({ id: inserted.id, name }, { status: 201 })
}
