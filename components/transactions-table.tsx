"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
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
import {
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  CircleDashed,
  Tag,
} from "lucide-react"
import { filtersToParams, type DashboardFilters } from "@/lib/filters"
import { getCategoryColor } from "@/lib/category-colors"
import { ErrorState } from "@/components/error-state"

interface TxRow {
  id: string
  bookingDate: string
  valueDate: string | null
  status: string
  payer: string | null
  payee: string | null
  purpose: string | null
  type: string
  counterpartyIban: string | null
  amountCents: number
  categoryId: number | null
  categoryName: string | null
  labelStatus: string
}

interface TransactionsResponse {
  rows: TxRow[]
  total: number
  page: number
  pageCount: number
}

function euro(cents: number): string {
  const abs = Math.abs(cents)
  const int = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, "0")
  return `${cents < 0 ? "−" : ""}${int.toLocaleString("de-DE")},${frac} €`
}

type SortKey = "bookingDate" | "amountCents" | "payee"

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
      className="category-badge"
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

function SortHeader({
  label,
  sortKey,
  sort,
  onToggle,
}: {
  label: string
  sortKey: SortKey
  sort: { key: SortKey; desc: boolean }
  onToggle: (key: SortKey) => void
}) {
  const active = sort.key === sortKey
  return (
    <button
      className={`flex items-center gap-1 font-medium ${active ? "text-foreground" : "hover:text-foreground"}`}
      onClick={() => onToggle(sortKey)}
    >
      {label}
      {active ? (
        sort.desc ? (
          <ArrowDown className="size-3" />
        ) : (
          <ArrowUp className="size-3" />
        )
      ) : (
        <ArrowUpDown className="size-3 opacity-50" />
      )}
    </button>
  )
}

export function TransactionsTable({ filters }: { filters: DashboardFilters }) {
  const [page, setPage] = React.useState(1)
  const [sort, setSort] = React.useState<{ key: SortKey; desc: boolean }>({
    key: "bookingDate",
    desc: true,
  })

  const params = React.useMemo(() => {
    const sp = filtersToParams(filters)
    sp.set("page", String(page))
    sp.set("pageSize", "25")
    sp.set("sort", sort.key === "amountCents" ? "amount_cents" : sort.key)
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
    useQuery<TransactionsResponse>({
      queryKey: ["transactions", params.toString()],
      queryFn: async () => {
        const res = await fetch(`/api/transactions?${params}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      },
      placeholderData: (prev) => prev,
    })

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
                      <CategoryCell row={row} />
                    </TableCell>
                    <TableCell
                      className={`text-right font-medium whitespace-nowrap tabular-nums ${
                        row.amountCents < 0
                          ? "text-foreground"
                          : "text-emerald-700 dark:text-emerald-400"
                      }`}
                    >
                      {euro(row.amountCents)}
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
    </div>
  )
}
