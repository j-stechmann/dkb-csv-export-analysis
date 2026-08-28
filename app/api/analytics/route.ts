import { NextRequest, NextResponse } from "next/server"
import { parseFilters } from "@/lib/analytics/queries"
import { computeAnalytics } from "@/lib/analytics/engine"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams
  const filters = parseFilters(sp)
  const result = computeAnalytics(filters, new Date().toISOString().slice(0, 10))
  return NextResponse.json(result)
}