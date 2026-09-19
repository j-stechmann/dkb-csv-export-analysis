import { NextRequest, NextResponse } from "next/server"
import { and, eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { importBatches } from "@/lib/db/schema"
import { withLabelCounters } from "@/lib/import/counters"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const { id } = await params
  const db = getDb()
  const batch = db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.id, id), eq(importBatches.userId, session.uid)))
    .get()
  if (!batch) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  return NextResponse.json(withLabelCounters(batch))
}
