import { NextResponse } from "next/server"
import { eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { importBatches } from "@/lib/db/schema"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = getDb()
  const batch = db
    .select()
    .from(importBatches)
    .where(eq(importBatches.id, id))
    .get()
  if (!batch) {
    return NextResponse.json({ error: "not_found" }, { status: 404 })
  }
  return NextResponse.json(batch)
}
