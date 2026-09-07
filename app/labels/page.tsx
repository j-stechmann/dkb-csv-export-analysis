"use client"

import * as React from "react"
import { Pencil, Trash2 } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ErrorState } from "@/components/error-state"
import { getCategoryColor } from "@/lib/category-colors"
import { useLabels } from "@/hooks/use-queries"
import type { Label } from "@/lib/api/client"
import { OriginBadge } from "./_components/origin-badge"
import { CreateLabelForm } from "./_components/create-label-form"
import { RenameLabelDialog } from "./_components/rename-label-dialog"
import { DeleteLabelDialog } from "./_components/delete-label-dialog"
import { RulesList } from "./_components/rules-list"

export default function LabelsPage() {
  const { data, isLoading, isError, refetch } = useLabels()

  const [renameTarget, setRenameTarget] = React.useState<Label | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<Label | null>(null)
  const [expandedId, setExpandedId] = React.useState<number | null>(null)

  const labels = data ?? []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight">
          Labels
        </h1>
        <p className="text-sm text-muted-foreground">
          Kategorien verwalten. Gelernte Regeln entstehen durch manuelle
          Zuweisung in der Transaktionstabelle, können bearbeitet werden und
          schlagen passende Labels dem LLM vor. Mit &quot;Anwenden&quot; wird
          eine Regel auf alle bestehenden passenden Transaktionen losgelassen.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Neues Label</CardTitle>
          <CardDescription>
            Erstellt ein manuelles Label, das das LLM sofort verwenden kann.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateLabelForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Alle Labels {data ? `(${labels.length})` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading && labels.length === 0 ? (
            <p className="text-sm text-muted-foreground">…</p>
          ) : isError ? (
            <ErrorState onRetry={() => void refetch()} />
          ) : labels.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Noch keine Labels vorhanden.
            </p>
          ) : (
            labels.map((label) => (
              <div
                key={label.id}
                className="rounded-lg border p-3 transition-colors hover:bg-accent/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="size-3 shrink-0 rounded-full"
                      style={
                        {
                          "--category-color": getCategoryColor(label.id),
                        } as React.CSSProperties
                      }
                    />
                    <span className="truncate font-medium">{label.name}</span>
                    <OriginBadge origin={label.origin} />
                    <Badge
                      variant="outline"
                      className="font-normal text-muted-foreground tabular-nums"
                    >
                      {label.usageCount}×
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setExpandedId((id) =>
                          id === label.id ? null : label.id
                        )
                      }
                    >
                      {label.ruleCount}{" "}
                      {label.ruleCount === 1 ? "Regel" : "Regeln"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRenameTarget(label)}
                      aria-label={`Label ${label.name} umbenennen`}
                    >
                      <Pencil className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(label)}
                      aria-label={`Label ${label.name} löschen`}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                {expandedId === label.id && (
                  <div className="mt-2 border-t pt-2">
                    <RulesList labelId={label.id} labels={labels} />
                  </div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {renameTarget && (
        <RenameLabelDialog
          label={renameTarget}
          onClose={() => setRenameTarget(null)}
        />
      )}
      {deleteTarget && (
        <DeleteLabelDialog
          label={deleteTarget}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
