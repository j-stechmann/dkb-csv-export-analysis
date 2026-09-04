"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
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
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  CircleDashed,
  Plus,
  Tag,
} from "lucide-react"
import { toast } from "sonner"
import { filtersToParams, type DashboardFilters } from "@/lib/filters"
import { getCategoryColor } from "@/lib/category-colors"
import { ErrorState } from "@/components/error-state"
import { cn } from "@/lib/utils"

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

interface LabelOption {
  id: number
  name: string
  origin: string
}

function AssignLabelDialog({
  row,
  onClose,
}: {
  row: TxRow
  onClose: () => void
}) {
  const [search, setSearch] = React.useState("")
  const [selectedId, setSelectedId] = React.useState<number | null>(
    row.categoryId
  )
  const [busy, setBusy] = React.useState(false)
  const queryClient = useQueryClient()

  const { data } = useQuery<{ labels: LabelOption[] }>({
    queryKey: ["labels"],
    queryFn: async () => {
      const res = await fetch("/api/labels")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
  })

  const labels = (data?.labels ?? []).filter((l) =>
    l.name.toLowerCase().includes(search.toLowerCase())
  )
  const exactMatch = (data?.labels ?? []).find(
    (l) => l.name.toLowerCase() === search.trim().toLowerCase()
  )
  const selected = (data?.labels ?? []).find((l) => l.id === selectedId)

  const assign = async () => {
    if (!selectedId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/transactions/${row.id}/label`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelId: selectedId }),
      })
      const data2 = (await res.json()) as { error?: string }
      if (res.ok) {
        toast.success("Kategorie zugewiesen", {
          description: `Regel für ${row.type === "Ausgang" ? (row.payee ?? "Vertragspartner") : (row.payer ?? "Vertragspartner")} gelernt.`,
        })
        void queryClient.invalidateQueries({ queryKey: ["transactions"] })
        void queryClient.invalidateQueries({ queryKey: ["analytics"] })
        void queryClient.invalidateQueries({ queryKey: ["categories"] })
        void queryClient.invalidateQueries({ queryKey: ["labels"] })
        onClose()
      } else {
        toast.error("Zuweisung fehlgeschlagen", {
          description: data2.error ?? `HTTP ${res.status}`,
        })
      }
    } finally {
      setBusy(false)
    }
  }

  const createAndAssign = async () => {
    if (!search.trim() || exactMatch) return
    setBusy(true)
    try {
      const res = await fetch(`/api/transactions/${row.id}/label`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labelName: search.trim() }),
      })
      const data2 = (await res.json()) as { error?: string }
      if (res.ok) {
        toast.success(`Label "${search.trim()}" erstellt und zugewiesen`)
        void queryClient.invalidateQueries({ queryKey: ["transactions"] })
        void queryClient.invalidateQueries({ queryKey: ["analytics"] })
        void queryClient.invalidateQueries({ queryKey: ["categories"] })
        void queryClient.invalidateQueries({ queryKey: ["labels"] })
        onClose()
      } else {
        toast.error("Erstellen fehlgeschlagen", {
          description: data2.error ?? `HTTP ${res.status}`,
        })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Kategorie zuweisen</DialogTitle>
        </DialogHeader>
        <Input
          placeholder="Label suchen oder neu erstellen…"
          value={search}
          autoFocus
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {labels.map((label) => (
            <button
              key={label.id}
              className={cn(
                "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                selectedId === label.id && "border-primary bg-accent"
              )}
              onClick={() => setSelectedId(label.id)}
            >
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={
                  {
                    "--category-color": getCategoryColor(label.id),
                  } as React.CSSProperties
                }
              />
              <span className="truncate">{label.name}</span>
              {label.origin === "llm" && (
                <span className="ml-auto text-xs text-muted-foreground">
                  erfunden
                </span>
              )}
            </button>
          ))}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          {search.trim() && !exactMatch && (
            <Button
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => void createAndAssign()}
            >
              <Plus className="size-4" /> &quot;{search.trim()}&quot; neu
              erstellen und zuweisen
            </Button>
          )}
          <div className="flex w-full justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Abbrechen
            </Button>
            <Button
              disabled={busy || !selectedId}
              onClick={() => void assign()}
            >
              {selected ? `Zuweisen: ${selected.name}` : "Zuweisen"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [assignTarget, setAssignTarget] = React.useState<TxRow | null>(null)

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

      {assignTarget && (
        <AssignLabelDialog
          row={assignTarget}
          onClose={() => setAssignTarget(null)}
        />
      )}
    </div>
  )
}
