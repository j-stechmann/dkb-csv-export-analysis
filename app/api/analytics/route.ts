import { NextRequest, NextResponse } from "next/server"
import { parseFilters } from "@/lib/analytics/queries"
import { computeAnalytics } from "@/lib/analytics/engine"
import { todayLocal } from "@/lib/analytics/date"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams
  const filters = parseFilters(sp)
  const result = computeAnalytics(filters, todayLocal())
  return NextResponse.json(result)
}
