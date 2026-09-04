import { NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { categories, transactions } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const db = getDb()
  const rows = db
    .select({
      id: categories.id,
      name: categories.name,
      origin: categories.origin,
      usageCount: categories.usageCount,
      count: sql<number>`COUNT(${transactions.id})`,
    })
    .from(categories)
    .leftJoin(transactions, eq(transactions.categoryId, categories.id))
    .groupBy(
      categories.id,
      categories.name,
      categories.origin,
      categories.usageCount
    )
    .orderBy(categories.name)
    .all()
  return NextResponse.json({ categories: rows })
}
