"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useRenameLabel } from "@/hooks/use-mutations"
import type { Label } from "@/lib/api/client"

export function RenameLabelDialog({
  label,
  onClose,
}: {
  label: Label
  onClose: () => void
}) {
  const [name, setName] = React.useState(label.name)
  const rename = useRenameLabel()

  const save = () => {
    rename.mutate(
      { id: label.id, name: name.trim() },
      {
        onSuccess: onClose,
      }
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Label umbenennen</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          maxLength={64}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save()
          }}
        />
        <p className="text-xs text-muted-foreground">
          Umbenannte Labels gelten als bestätigt und werden nicht mehr als
          &quot;erfunden&quot; markiert.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button disabled={rename.isPending || !name.trim()} onClick={save}>
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
