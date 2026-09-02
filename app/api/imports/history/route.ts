import { NextResponse } from "next/server"
import { desc } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { importBatches } from "@/lib/db/schema"
import { withLabelCounters } from "@/lib/import/counters"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const db = getDb()
  const batches = db
    .select()
    .from(importBatches)
    .orderBy(desc(importBatches.createdAt))
    .limit(50)
    .all()
  return NextResponse.json({ batches: batches.map(withLabelCounters) })
}
