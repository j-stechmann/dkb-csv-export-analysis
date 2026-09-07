"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Plus } from "lucide-react"
import { toast } from "sonner"
import type { TransactionPage } from "@/lib/api/client"
import { useCategories } from "@/hooks/use-queries"
import { useAssignLabel } from "@/hooks/use-mutations"
import { getCategoryColor } from "@/lib/category-colors"
import { ErrorState } from "@/components/error-state"
import { cn } from "@/lib/utils"

export interface AssignLabelDialogProps {
  row: TransactionPage["rows"][number]
  onClose: () => void
}

export function AssignLabelDialog({ row, onClose }: AssignLabelDialogProps) {
  const [search, setSearch] = React.useState("")
  const [selectedId, setSelectedId] = React.useState<number | null>(
    row.categoryId
  )

  const { data, isLoading, isError, refetch } = useCategories()
  const assignLabel = useAssignLabel()
  const busy = assignLabel.isPending

  const allLabels = data ?? []
  const labels = allLabels.filter((l) =>
    l.name.toLowerCase().includes(search.toLowerCase())
  )
  const exactMatch = allLabels.find(
    (l) => l.name.toLowerCase() === search.trim().toLowerCase()
  )
  const selected = allLabels.find((l) => l.id === selectedId)

  const assign = (labelId?: number) => {
    const id = labelId ?? selectedId
    if (!id) return
    assignLabel.mutate(
      { txId: row.id, labelId: id },
      {
        onSuccess: () => {
          toast.success("Kategorie zugewiesen", {
            description: `Regel für ${row.type === "Ausgang" ? (row.payee ?? "Vertragspartner") : (row.payer ?? "Vertragspartner")} gelernt.`,
          })
          onClose()
        },
      }
    )
  }

  const createAndAssign = () => {
    if (!search.trim() || exactMatch) return
    assignLabel.mutate(
      { txId: row.id, labelName: search.trim() },
      {
        onSuccess: () => {
          toast.success(`Label "${search.trim()}" erstellt und zugewiesen`)
          onClose()
        },
      }
    )
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
          {isLoading ? (
            <div className="space-y-1 p-1">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : isError ? (
            <ErrorState
              onRetry={() => void refetch()}
              className="justify-center border-none bg-transparent"
            />
          ) : (
            labels.map((label) => (
              <button
                key={label.id}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                  selectedId === label.id && "border-primary bg-accent",
                  busy && "pointer-events-none opacity-50"
                )}
                onClick={() => setSelectedId(label.id)}
                onDoubleClick={() => assign(label.id)}
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
            ))
          )}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          {search.trim() && !exactMatch && (
            <Button
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => createAndAssign()}
            >
              <Plus className="size-4" /> &quot;{search.trim()}&quot; neu
              erstellen und zuweisen
            </Button>
          )}
          <div className="flex w-full justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Abbrechen
            </Button>
            <Button disabled={busy || !selectedId} onClick={() => assign()}>
              {selected ? `Zuweisen: ${selected.name}` : "Zuweisen"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
