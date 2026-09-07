"use client"

import { X } from "lucide-react"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useActiveImport } from "@/components/active-import-provider"
import { labelProgress, rowProgress, STAGE_LABELS } from "@/lib/import-progress"

export function ImportProgressPill() {
  const { batch, clearActive } = useActiveImport()
  if (!batch) return null

  const terminal = batch.status === "completed" || batch.status === "failed"
  const labels = labelProgress(batch)
  const rows = rowProgress(batch)

  return (
    <div className="fixed bottom-4 left-1/2 z-[90] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border bg-background/95 p-4 shadow-lg backdrop-blur">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium">{batch.fileName}</p>
        <div className="flex items-center gap-2">
          <Badge
            variant={
              batch.status === "failed"
                ? "destructive"
                : terminal
                  ? "secondary"
                  : "default"
            }
          >
            {STAGE_LABELS[batch.status] ?? batch.status}
          </Badge>
          {terminal && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={clearActive}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      </div>
      {!terminal ? (
        <div className="space-y-2">
          {batch.status === "parsing" || batch.status === "importing" ? (
            <div>
              <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                <span>Zeilen</span>
                <span>
                  {batch.rowsImported + batch.rowsDuplicate + batch.rowsUpdated}{" "}
                  / {batch.rowsTotal}
                </span>
              </div>
              <Progress value={rows} />
            </div>
          ) : null}
          {batch.status === "labeling" || batch.status === "importing" ? (
            <div>
              <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                <span>Kategorisierung</span>
                <span>
                  {batch.labelsDone}/{batch.labelsTotal}
                  {batch.labelsFailed > 0
                    ? ` (${batch.labelsFailed} fehlgeschlagen)`
                    : ""}
                </span>
              </div>
              <Progress value={labels} />
            </div>
          ) : null}
        </div>
      ) : batch.status === "completed" ? (
        <p className="text-xs text-muted-foreground">
          {batch.rowsImported} neu importiert · {batch.rowsDuplicate} Duplikate
          {batch.rowsUpdated > 0 ? ` · ${batch.rowsUpdated} aktualisiert` : ""}
          {batch.labelsTotal - batch.labelsDone - batch.labelsFailed > 0
            ? ` · ${
                batch.labelsTotal - batch.labelsDone - batch.labelsFailed
              } ohne Kategorie (erneut versuchen auf der Imports-Seite)`
            : batch.labelsFailed > 0
              ? ` · ${batch.labelsFailed} ohne Kategorie (erneut versuchen auf der Imports-Seite)`
              : ""}
        </p>
      ) : (
        <p className="text-xs text-destructive">{batch.error}</p>
      )}
    </div>
  )
}
