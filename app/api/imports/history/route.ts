import { NextRequest, NextResponse } from "next/server"
import { desc, eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { importBatches } from "@/lib/db/schema"
import { withLabelCounters } from "@/lib/import/counters"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const db = getDb()
  const batches = db
    .select()
    .from(importBatches)
    .where(eq(importBatches.userId, session.uid))
    .orderBy(desc(importBatches.createdAt))
    .limit(50)
    .all()
  return NextResponse.json({ batches: batches.map(withLabelCounters) })
}
