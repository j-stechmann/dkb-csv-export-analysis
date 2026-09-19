import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { categories, transactions } from "@/lib/db/schema"
import { and, eq, sql } from "drizzle-orm"
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
      count: sql<number>`COUNT(${transactions.id})`,
    })
    .from(categories)
    .leftJoin(
      transactions,
      and(
        eq(transactions.categoryId, categories.id),
        eq(transactions.userId, categories.userId)
      )
    )
    .where(eq(categories.userId, session.uid))
    .groupBy(
      categories.id,
      categories.name,
      categories.origin,
      categories.usageCount,
      categories.color
    )
    .orderBy(categories.name)
    .all()
  return NextResponse.json({ categories: rows })
}
