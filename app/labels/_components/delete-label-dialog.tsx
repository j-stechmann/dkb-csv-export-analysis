"use client"

import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useDeleteLabel } from "@/hooks/use-mutations"
import type { Label } from "@/lib/api/client"

export function DeleteLabelDialog({
  label,
  onClose,
}: {
  label: Label
  onClose: () => void
}) {
  const remove = useDeleteLabel()

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Label löschen?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Das Label &quot;{label.name}&quot; wird entfernt ({label.ruleCount}{" "}
          gelernte {label.ruleCount === 1 ? "Regel" : "Regeln"} inklusive). Alle
          Transaktionen mit diesem Label verlieren ihre Kategorie und werden vom
          LLM neu kategorisiert.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(label.id, {
                onSuccess: onClose,
              })
            }
          >
            <Trash2 className="size-4" /> Löschen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
