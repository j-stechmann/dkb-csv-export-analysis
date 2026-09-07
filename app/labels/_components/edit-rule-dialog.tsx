"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useEditRule } from "@/hooks/use-mutations"
import type { Label, LabelRule } from "@/lib/api/client"

export function EditRuleDialog({
  rule,
  labels,
  onClose,
}: {
  rule: LabelRule
  labels: Label[]
  onClose: () => void
}) {
  const [labelId, setLabelId] = React.useState(String(rule.labelId))
  const [iban, setIban] = React.useState(rule.iban)
  const [name, setName] = React.useState(rule.name)
  const editRule = useEditRule()

  const save = () => {
    editRule.mutate(
      {
        id: rule.id,
        labelId: Number.parseInt(labelId, 10),
        iban: iban.trim(),
        name: name.trim(),
      },
      {
        onSuccess: onClose,
      }
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Regel bearbeiten</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label
              htmlFor="rule-label"
              className="text-xs text-muted-foreground"
            >
              Label
            </label>
            <Select
              items={Object.fromEntries(
                labels.map((l) => [String(l.id), l.name])
              )}
              value={labelId}
              onValueChange={(value) => value && setLabelId(value)}
            >
              <SelectTrigger id="rule-label" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {labels.map((label) => (
                  <SelectItem key={label.id} value={String(label.id)}>
                    {label.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="rule-iban"
              className="text-xs text-muted-foreground"
            >
              IBAN
            </label>
            <Input
              id="rule-iban"
              value={iban}
              autoFocus
              onChange={(e) => setIban(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="rule-name"
              className="text-xs text-muted-foreground"
            >
              Name
            </label>
            <Input
              id="rule-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Änderungen wirken erst, wenn du die Regel mit &quot;Anwenden&quot;
            auf bestehende Transaktionen loslässt.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            disabled={editRule.isPending || !iban.trim() || !name.trim()}
            onClick={save}
          >
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
