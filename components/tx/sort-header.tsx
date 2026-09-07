"use client"

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"

export type SortKey = "bookingDate" | "amountCents" | "payee"

export function SortHeader({
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
  const direction = active ? (sort.desc ? "absteigend" : "aufsteigend") : ""
  return (
    <button
      className={`flex items-center gap-1 font-medium ${active ? "text-foreground" : "hover:text-foreground"}`}
      onClick={() => onToggle(sortKey)}
      aria-label={
        direction ? `${label}, sortiert ${direction}` : `${label} sortieren`
      }
      aria-pressed={active}
    >
      {label}
      {active ? (
        sort.desc ? (
          <ArrowDown className="size-3" aria-hidden="true" />
        ) : (
          <ArrowUp className="size-3" aria-hidden="true" />
        )
      ) : (
        <ArrowUpDown className="size-3 opacity-50" aria-hidden="true" />
      )}
    </button>
  )
}
