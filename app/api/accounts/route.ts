import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { accounts } from "@/lib/db/schema"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const db = getDb()
  const rows = db.select().from(accounts).all()
  return NextResponse.json({ accounts: rows })
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    iban?: string
    name?: string
  } | null
  if (!body?.iban || !body?.name) {
    return NextResponse.json(
      { error: "iban and name required" },
      { status: 400 }
    )
  }
  const db = getDb()
  const inserted = db
    .insert(accounts)
    .values({ iban: body.iban.toUpperCase(), name: body.name })
    .onConflictDoNothing()
    .returning()
    .get()
  return NextResponse.json({ account: inserted }, { status: 201 })
}
