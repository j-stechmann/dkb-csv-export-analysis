import { NextRequest, NextResponse } from "next/server"
import { queryTransactions } from "@/lib/analytics/queries"
import {
  parseQuery,
  TransactionsQuerySchema,
  type TransactionsQuery,
} from "@/lib/api/schemas"
import { badRequest, withRoute } from "@/lib/api/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  return withRoute(async () => {
    const query = parseQuery(
      TransactionsQuerySchema,
      request.nextUrl.searchParams
    )
    if (query === null) {
      return badRequest("invalid_query", "Ungültige Abfrageparameter")
    }

    const { page, pageSize, ...filterInput } = query
    const filters = filtersFromQuery(filterInput)
    const result = queryTransactions(filters, page, pageSize)
    return NextResponse.json(result)
  })
}

/** Map the validated query onto TransactionFilters. */
function filtersFromQuery(q: Omit<TransactionsQuery, "page" | "pageSize">) {
  return {
    q: q.q || undefined,
    dateFrom: q.dateFrom,
    dateTo: q.dateTo,
    type: q.type,
    categoryIds:
      q.categoryId && q.categoryId.length > 0 ? q.categoryId : undefined,
    accountId: q.accountId,
    labelStatus: q.labelStatus,
    status: q.status,
    sort: q.sort,
    dir: q.dir,
  }
}
