"use client"

import * as React from "react"
import { Pencil, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useLabelRules } from "@/hooks/use-queries"
import { useDeleteRule } from "@/hooks/use-mutations"
import type { Label } from "@/lib/api/client"
import { ApplyRuleDialog } from "./apply-rule-dialog"
import { EditRuleDialog } from "./edit-rule-dialog"

export function RulesList({
  labelId,
  labels,
}: {
  labelId: number
  labels: Label[]
}) {
  const { data } = useLabelRules(labelId)
  const [editTargetId, setEditTargetId] = React.useState<number | null>(null)
  const [applyTargetId, setApplyTargetId] = React.useState<number | null>(null)
  const deleteRule = useDeleteRule()

  const rules = data ?? []
  if (rules.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Keine gelernten Regeln – Regeln entstehen durch manuelle Zuweisung in
        der Transaktionstabelle.
      </p>
    )
  }

  // Derive dialogs from the live rules list so a deleted rule (or its label)
  // closes the dialog instead of operating on stale state.
  const editTarget = rules.find((r) => r.id === editTargetId) ?? null
  const applyTarget = rules.find((r) => r.id === applyTargetId) ?? null

  return (
    <div className="space-y-1">
      {rules.map((rule) => {
        const rowBusy = deleteRule.isPending && deleteRule.variables === rule.id
        return (
          <div
            key={rule.id}
            className="flex items-center justify-between gap-2 rounded border px-2 py-1"
          >
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{rule.name}</p>
              <p
                className="truncate text-xs text-muted-foreground"
                title={rule.iban}
              >
                {rule.iban}
              </p>
            </div>
            <div className="flex shrink-0 items-center">
              <Button
                variant="ghost"
                size="sm"
                disabled={rowBusy}
                onClick={() => setEditTargetId(rule.id)}
                title="Regel bearbeiten"
                aria-label={`Regel ${rule.name} bearbeiten`}
              >
                <Pencil className="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={rowBusy}
                onClick={() => setApplyTargetId(rule.id)}
                title="Auf bestehende Transaktionen anwenden"
                aria-label={`Regel ${rule.name} auf bestehende Transaktionen anwenden`}
              >
                <RefreshCw className="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={rowBusy}
                onClick={() => deleteRule.mutate(rule.id)}
                title="Regel löschen"
                aria-label={`Regel ${rule.name} löschen`}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          </div>
        )
      })}
      {editTarget && (
        <EditRuleDialog
          rule={editTarget}
          labels={labels}
          onClose={() => setEditTargetId(null)}
        />
      )}
      {applyTarget && (
        <ApplyRuleDialog
          rule={applyTarget}
          labels={labels}
          onClose={() => setApplyTargetId(null)}
        />
      )}
    </div>
  )
}
