"use client"

import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useRuleMatches } from "@/hooks/use-queries"
import { useApplyRule } from "@/hooks/use-mutations"
import type { Label, LabelRule } from "@/lib/api/client"

export function ApplyRuleDialog({
  rule,
  labels,
  onClose,
}: {
  rule: LabelRule
  labels: Label[]
  onClose: () => void
}) {
  const apply = useApplyRule()

  // Live query instead of a one-shot fetch: the invalidation in the mutation
  // hooks refetches it while the dialog is open, so the preview count tracks
  // transaction changes.
  const { data, isLoading, isError: failed } = useRuleMatches(rule.id)
  const count = data ?? null

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Regel anwenden?</DialogTitle>
        </DialogHeader>
        {failed ? (
          <p className="text-sm text-destructive">
            Treffer konnten nicht gezählt werden.
          </p>
        ) : isLoading || count === null ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {count === 1
              ? "Eine Transaktion passt zu dieser Regel. Sie erhält das Label "
              : `${count} Transaktionen passen zu dieser Regel. Sie erhalten das Label `}
            &quot;{labels.find((l) => l.id === rule.labelId)?.name ?? "?"}&quot;
            zugeordnet und {count === 1 ? "wird" : "werden"} vom LLM neu
            kategorisiert – auch bereits manuell zugewiesene.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            disabled={
              apply.isPending || failed || count === null || count === 0
            }
            onClick={() =>
              apply.mutate(rule.id, {
                onSuccess: onClose,
              })
            }
          >
            <RefreshCw className="size-4" /> Anwenden
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
