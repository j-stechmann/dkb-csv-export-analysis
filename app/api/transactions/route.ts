import { NextRequest, NextResponse } from "next/server"
import { parseFilters, queryTransactions } from "@/lib/analytics/queries"
import { requireSession, unauthorized } from "@/lib/auth/guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const sp = request.nextUrl.searchParams
  const filters = parseFilters(sp)

  const pageRaw = Number.parseInt(sp.get("page") ?? "1", 10)
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1
  const pageSizeRaw = Number.parseInt(sp.get("pageSize") ?? "25", 10)
  const pageSize =
    Number.isInteger(pageSizeRaw) && pageSizeRaw > 0
      ? Math.min(pageSizeRaw, 100)
      : 25

  const result = queryTransactions(filters, session.uid, page, pageSize)
  return NextResponse.json(result)
}
