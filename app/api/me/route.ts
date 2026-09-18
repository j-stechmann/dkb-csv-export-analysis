import { NextRequest, NextResponse } from "next/server"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Whoami for the header user chip (name/email only, nothing sensitive). */
export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  return NextResponse.json({
    user: { name: session.name, email: session.email },
  })
}
