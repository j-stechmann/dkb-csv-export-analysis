import { NextRequest, NextResponse } from "next/server"
import { eq } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { accounts } from "@/lib/db/schema"
import { parseBody, AccountCreateSchema } from "@/lib/api/schemas"
import { badRequest, jsonError, withRoute } from "@/lib/api/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return withRoute(async () => {
    const db = getDb()
    const rows = db.select().from(accounts).all()
    return NextResponse.json({ accounts: rows })
  })
}

export async function POST(request: NextRequest) {
  return withRoute(async () => {
    const body = await parseBody(AccountCreateSchema, request)
    if (body === null) {
      return badRequest("invalid_body", "iban und name werden benötigt")
    }

    const db = getDb()
    const inserted = db
      .insert(accounts)
      .values({ iban: body.iban, name: body.name })
      .onConflictDoNothing()
      .returning()
      .get()
    if (!inserted) {
      // duplicate IBAN: return the existing account, never an empty body
      const existing = db
        .select()
        .from(accounts)
        .where(eq(accounts.iban, body.iban))
        .get()
      if (!existing) {
        throw new Error("account insert conflicted but existing row not found")
      }
      return jsonError(
        "account_exists",
        "Konto mit dieser IBAN existiert bereits",
        409,
        { account: existing }
      )
    }
    return NextResponse.json({ account: inserted }, { status: 201 })
  })
}
