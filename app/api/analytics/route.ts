import { NextRequest, NextResponse } from "next/server"
import { parseFilters } from "@/lib/analytics/queries"
import { computeAnalytics } from "@/lib/analytics/engine"
import { todayLocal } from "@/lib/analytics/date"
import { withRoute } from "@/lib/api/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  return withRoute(async () => {
    const filters = parseFilters(request.nextUrl.searchParams)
    const result = computeAnalytics(filters, todayLocal())
    return NextResponse.json(result)
  })
}
