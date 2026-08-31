"use client"

import * as React from "react"
import { FilterBar } from "@/components/filter-bar"
import { KpiRow, useAnalytics } from "@/components/analytics-kpis"
import {
  BalanceChart,
  CashflowChart,
  TopCategoriesChart,
} from "@/components/analytics-charts"
import { TransactionsTable } from "@/components/transactions-table"
import { ErrorState } from "@/components/error-state"
import { EMPTY_FILTERS, type DashboardFilters } from "@/lib/filters"

export default function DashboardPage() {
  const [filters, setFilters] = React.useState<DashboardFilters>(EMPTY_FILTERS)

  const params = React.useMemo(() => {
    const sp = new URLSearchParams()
    if (filters.q) sp.set("q", filters.q)
    if (filters.dateFrom) sp.set("dateFrom", filters.dateFrom)
    if (filters.dateTo) sp.set("dateTo", filters.dateTo)
    if (filters.type !== "all") sp.set("type", filters.type)
    for (const id of filters.categoryIds) sp.append("categoryId", String(id))
    return sp.toString()
  }, [filters])

  const {
    data: analytics,
    isLoading,
    isFetching,
    isError,
    refetch,
  } = useAnalytics(params)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight">
          Dashboard
        </h1>
        <p className="text-sm text-muted-foreground">
          Analysen basieren auf den gefilterten Transaktionen.
        </p>
      </div>

      <FilterBar filters={filters} onChange={setFilters} />

      {isError && <ErrorState onRetry={() => void refetch()} />}

      <div
        className={`space-y-6 transition-opacity ${isFetching && !isLoading ? "opacity-70" : ""}`}
      >
        <KpiRow analytics={analytics} loading={isLoading} />

        <div className="grid gap-4 lg:grid-cols-3">
          <CashflowChart
            data={analytics?.monthlyCashflow}
            loading={isLoading}
          />
          <TopCategoriesChart
            data={analytics?.topCategories}
            loading={isLoading}
          />
        </div>

        <BalanceChart data={analytics?.balanceTimeline} loading={isLoading} />
      </div>

      <div>
        <h2 className="mb-3 font-serif text-lg font-semibold">Transaktionen</h2>
        <TransactionsTable filters={filters} />
      </div>
    </div>
  )
}
