"use client"

import * as React from "react"
import { Upload, FolderOpen, RefreshCw, FileSpreadsheet } from "lucide-react"
import { toast } from "sonner"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { useActiveImport } from "@/components/active-import-provider"
import { ErrorState } from "@/components/error-state"
import { useImportHistory } from "@/hooks/use-queries"
import { useRetryLabeling, useStartImport } from "@/hooks/use-mutations"
import { labelProgress, rowProgress, STAGE_LABELS } from "@/lib/import-progress"
import { cn } from "@/lib/utils"

function ImportDropzone() {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const { startPolling } = useActiveImport()
  const { mutate: startImport, isPending: isUploading } = useStartImport()

  const upload = (file: File) => {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast.error("Nur CSV-Dateien werden unterstützt", {
        description: file.name,
      })
      return
    }
    startImport({ file }, { onSuccess: (data) => startPolling(data.batchId) })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Neuer Import</CardTitle>
        <CardDescription>
          DKB CSV-Export hierher ziehen oder auswählen. Die Verarbeitung erfolgt
          im Hintergrund; Duplikate werden automatisch erkannt.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 text-center transition-colors",
            "hover:border-primary/50 hover:bg-accent/40"
          )}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const file = e.dataTransfer.files[0]
            if (file) upload(file)
          }}
        >
          <Upload className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            CSV-Datei hier ablegen
          </p>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) upload(f)
              e.target.value = ""
            }}
          />
          <Button
            disabled={isUploading}
            onClick={() => inputRef.current?.click()}
          >
            <FolderOpen className="size-4" />
            {isUploading ? "Wird hochgeladen…" : "Datei auswählen"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function RetryLabelingButton() {
  const { mutate: retryLabeling, isPending } = useRetryLabeling()

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={isPending}
      onClick={() => retryLabeling()}
    >
      <RefreshCw className={cn("size-4", isPending && "animate-spin")} />
      Kategorisierung erneut versuchen
    </Button>
  )
}

function ActiveImportCard() {
  const { batch, activeBatchId } = useActiveImport()
  if (!batch || !activeBatchId) return null

  const terminal = batch.status === "completed" || batch.status === "failed"
  const labelPct = labelProgress(batch)
  const rowPct = rowProgress(batch)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{batch.fileName}</CardTitle>
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
        </div>
        <CardDescription>
          {batch.rowsTotal} Zeilen · {batch.rowsImported} neu ·{" "}
          {batch.rowsDuplicate} Duplikate · {batch.rowsUpdated} aktualisiert
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!terminal && (
          <>
            <div>
              <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                <span>Speichern</span>
                <span>
                  {batch.rowsImported + batch.rowsDuplicate + batch.rowsUpdated}
                  /{batch.rowsTotal}
                </span>
              </div>
              <Progress value={rowPct} />
            </div>
            <div>
              <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                <span>Kategorisierung</span>
                <span>
                  {batch.labelsDone}/{batch.labelsTotal}
                </span>
              </div>
              <Progress value={labelPct} />
            </div>
          </>
        )}
        {batch.status === "failed" && batch.error && (
          <p className="text-sm text-destructive">{batch.error}</p>
        )}
      </CardContent>
    </Card>
  )
}

function HistoryTable() {
  const { data, isLoading, isError, refetch } = useImportHistory()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Import-Verlauf</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Lädt…</p>
        ) : isError ? (
          <ErrorState onRetry={() => void refetch()} />
        ) : !data || data.length === 0 ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <FileSpreadsheet className="size-4" /> Noch keine Imports.
          </p>
        ) : (
          <div className="space-y-2">
            {data.map((b) => (
              <div
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{b.fileName}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(b.createdAt).toLocaleString("de-DE")} ·{" "}
                    {b.rowsImported} neu · {b.rowsDuplicate} Duplikate ·{" "}
                    {b.rowsUpdated} aktualisiert
                    {b.labelsFailed > 0
                      ? ` · ${b.labelsFailed} ohne Kategorie`
                      : ""}
                  </p>
                  {b.error && (
                    <p className="mt-1 text-xs text-destructive">{b.error}</p>
                  )}
                </div>
                <Badge
                  variant={
                    b.status === "failed"
                      ? "destructive"
                      : b.status === "completed"
                        ? "secondary"
                        : "default"
                  }
                >
                  {STAGE_LABELS[b.status] ?? b.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function ImportsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight">
          Imports
        </h1>
        <p className="text-sm text-muted-foreground">
          CSV-Exporte importieren und Verlauf einsehen.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ImportDropzone />
        <ActiveImportCard />
      </div>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Konfiguration: LLM-URL (llama-server) und Kategoriensprache werden
          über Umgebungsvariablen gesetzt (LLM_BASE_URL, LLM_LANGUAGE).
        </p>
        <RetryLabelingButton />
      </div>
      <HistoryTable />
    </div>
  )
}
