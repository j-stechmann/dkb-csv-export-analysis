"use client"

import * as React from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ChevronLeft, ChevronRight, CircleDashed, Tag } from "lucide-react"
import { filtersToParams, type DashboardFilters } from "@/lib/filters"
import { getCategoryColor } from "@/lib/category-colors"
import { ErrorState } from "@/components/error-state"
import { formatCentsAsGerman } from "@/lib/money"
import type { TransactionPage } from "@/lib/api/client"
import { useTransactions } from "@/hooks/use-queries"
import { SortHeader, type SortKey } from "@/components/tx/sort-header"
import { AssignLabelDialog } from "@/components/tx/assign-label-dialog"

type TxRow = TransactionPage["rows"][number]

function CategoryCell({ row }: { row: TxRow }) {
  if (row.labelStatus === "pending") {
    return (
      <Badge
        variant="outline"
        className="gap-1 font-normal text-muted-foreground"
      >
        <CircleDashed className="size-3" /> wird kategorisiert
      </Badge>
    )
  }
  if (row.labelStatus === "failed" || !row.categoryName) {
    return (
      <Badge
        variant="outline"
        className="gap-1 font-normal text-muted-foreground"
      >
        <Tag className="size-3" /> ohne Kategorie
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="category-badge font-normal"
      style={
        {
          "--category-color": getCategoryColor(row.categoryId),
        } as React.CSSProperties
      }
    >
      {row.categoryName}
    </Badge>
  )
}

export function TransactionsTable({ filters }: { filters: DashboardFilters }) {
  const [page, setPage] = React.useState(1)
  const [sort, setSort] = React.useState<{ key: SortKey; desc: boolean }>({
    key: "bookingDate",
    desc: true,
  })
  const [assignTarget, setAssignTarget] = React.useState<TxRow | null>(null)

  const params = React.useMemo(() => {
    const sp = filtersToParams(filters)
    sp.set("page", String(page))
    sp.set("pageSize", "25")
    // API sort keys are snake_case (booking_date | amount_cents | payee)
    const sortKey =
      sort.key === "bookingDate"
        ? "booking_date"
        : sort.key === "amountCents"
          ? "amount_cents"
          : "payee"
    sp.set("sort", sortKey)
    sp.set("dir", sort.desc ? "desc" : "asc")
    return sp
  }, [filters, page, sort])

  // value-based identity: page/reset must not fire on page changes
  const filterKey = React.useMemo(
    () => filtersToParams(filters).toString(),
    [filters]
  )
  const [lastFilterKey, setLastFilterKey] = React.useState(filterKey)
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey)
    setPage(1)
  }

  const { data, isLoading, isFetching, isError, refetch } =
    useTransactions(params)

  const toggleSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key ? { key, desc: !prev.desc } : { key, desc: true }
    )
    setPage(1)
  }

  const rows = data?.rows ?? []

  return (
    <div className="space-y-3">
      <div
        className={`rounded-lg border transition-opacity ${isFetching ? "opacity-70" : ""}`}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <SortHeader
                  label="Buchung"
                  sortKey="bookingDate"
                  sort={sort}
                  onToggle={toggleSort}
                />
              </TableHead>
              <TableHead>
                <SortHeader
                  label="Vertragspartner"
                  sortKey="payee"
                  sort={sort}
                  onToggle={toggleSort}
                />
              </TableHead>
              <TableHead>Kategorie</TableHead>
              <TableHead className="text-right">
                <SortHeader
                  label="Betrag"
                  sortKey="amountCents"
                  sort={sort}
                  onToggle={toggleSort}
                />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && rows.length === 0 ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 4 }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={4} className="h-32">
                  <ErrorState
                    onRetry={() => void refetch()}
                    className="justify-center border-none bg-transparent"
                  />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-32 text-center text-muted-foreground"
                >
                  Keine Transaktionen gefunden. CSV-Datei in das Fenster ziehen,
                  um zu importieren.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const counterparty =
                  row.type === "Ausgang" ? row.payee : row.payer
                return (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {row.bookingDate}
                    </TableCell>
                    <TableCell>
                      <div className="max-w-md min-w-0">
                        <p className="truncate font-medium">
                          {counterparty || "—"}
                        </p>
                        {row.purpose && (
                          <p
                            className="truncate text-xs text-muted-foreground"
                            title={row.purpose}
                          >
                            {row.purpose}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <button
                        className="inline-flex cursor-pointer items-center rounded-md transition-colors hover:bg-accent/60"
                        onClick={() => setAssignTarget(row)}
                        title="Kategorie zuweisen"
                      >
                        <CategoryCell row={row} />
                      </button>
                    </TableCell>
                    <TableCell
                      className={`text-right font-medium whitespace-nowrap tabular-nums ${
                        row.amountCents < 0
                          ? "text-foreground"
                          : "text-emerald-600 dark:text-emerald-400"
                      }`}
                    >
                      {formatCentsAsGerman(row.amountCents) + " €"}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {data ? `${data.total.toLocaleString("de-DE")} Transaktionen` : "…"}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="size-4" /> Zurück
          </Button>
          <span className="text-sm text-muted-foreground tabular-nums">
            {page} / {data?.pageCount ?? 1}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= (data?.pageCount ?? 1)}
            onClick={() => setPage((p) => p + 1)}
          >
            Weiter <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {assignTarget && (
        <AssignLabelDialog
          row={assignTarget}
          onClose={() => setAssignTarget(null)}
        />
      )}
    </div>
  )
}
