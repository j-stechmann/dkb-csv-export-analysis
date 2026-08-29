"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Search, RotateCcw } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { EMPTY_FILTERS, type DashboardFilters } from "@/lib/filters"
import { getCategoryColor } from "@/lib/category-colors"

interface CategoryOption {
  id: number
  name: string
}

function CategoryDot({ id }: { id: number }) {
  return (
    <span
      className="inline-block size-2 shrink-0 self-center rounded-full"
      style={{ backgroundColor: getCategoryColor(id) }}
      aria-hidden
    />
  )
}

export function FilterBar({
  filters,
  onChange,
}: {
  filters: DashboardFilters
  onChange: (f: DashboardFilters) => void
}) {
  const [qDraft, setQDraft] = React.useState(filters.q)
  const lastEmitted = React.useRef(filters.q)

  // debounce search input → propagate to parent via timeout callback
  React.useEffect(() => {
    const t = setTimeout(() => {
      if (qDraft !== lastEmitted.current) {
        lastEmitted.current = qDraft
        onChange({ ...filters, q: qDraft })
      }
    }, 300)
    return () => clearTimeout(t)
  }, [qDraft, filters, onChange])

  const { data: categories } = useQuery<CategoryOption[]>({
    queryKey: ["categories"],
    queryFn: async () => {
      const res = await fetch("/api/categories")
      const data = (await res.json()) as { categories: CategoryOption[] }
      return data.categories
    },
  })

  const categoryItems = React.useMemo(() => {
    const items: Record<string, React.ReactNode> = {
      all: "Alle Kategorien",
    }
    for (const c of categories ?? []) {
      items[String(c.id)] = c.name
    }
    return items
  }, [categories])

  const selectedCategory =
    filters.categoryIds.length === 1
      ? (categories ?? []).find((c) => c.id === filters.categoryIds[0])
      : undefined

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-56 flex-1">
        <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input
          value={qDraft}
          onChange={(e) => setQDraft(e.target.value)}
          placeholder="Suchen (Empfänger, Verwendungszweck)…"
          className="pl-8"
        />
      </div>

      <div className="flex items-center gap-1">
        <Input
          type="date"
          value={filters.dateFrom ?? ""}
          onChange={(e) =>
            onChange({ ...filters, dateFrom: e.target.value || null })
          }
          className="w-36"
          aria-label="Von"
        />
        <span className="text-muted-foreground">–</span>
        <Input
          type="date"
          value={filters.dateTo ?? ""}
          onChange={(e) =>
            onChange({ ...filters, dateTo: e.target.value || null })
          }
          className="w-36"
          aria-label="Bis"
        />
      </div>

      <Select
        items={{ all: "Alle", Eingang: "Eingang", Ausgang: "Ausgang" }}
        value={filters.type}
        onValueChange={(v) =>
          onChange({
            ...filters,
            type: String(v) as DashboardFilters["type"],
          })
        }
      >
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Alle</SelectItem>
          <SelectItem value="Eingang">Eingang</SelectItem>
          <SelectItem value="Ausgang">Ausgang</SelectItem>
        </SelectContent>
      </Select>

      <Select
        items={categoryItems}
        value={
          filters.categoryIds.length === 1
            ? String(filters.categoryIds[0])
            : "all"
        }
        onValueChange={(v) =>
          onChange({
            ...filters,
            categoryIds: v === "all" ? [] : [Number.parseInt(String(v), 10)],
          })
        }
      >
        <SelectTrigger className="w-48">
          {selectedCategory && <CategoryDot id={selectedCategory.id} />}
          <SelectValue placeholder="Kategorie" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Alle Kategorien</SelectItem>
          {(categories ?? []).map((c) => (
            <SelectItem key={c.id} value={String(c.id)}>
              <CategoryDot id={c.id} />
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        variant="ghost"
        size="icon"
        title="Filter zurücksetzen"
        onClick={() => {
          setQDraft("")
          onChange(EMPTY_FILTERS)
        }}
      >
        <RotateCcw className="size-4" />
      </Button>
    </div>
  )
}
