"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getCategoryColor } from "@/lib/category-colors"

interface LabelRow {
  id: number
  name: string
  origin: string
  usageCount: number
  ruleCount: number
}

interface LabelRuleRow {
  id: number
  labelId: number
  iban: string
  nameKey: string
  name: string
  createdAt: string
}

function invalidateAll(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["labels"] })
  void queryClient.invalidateQueries({ queryKey: ["label-rules"] })
  void queryClient.invalidateQueries({ queryKey: ["transactions"] })
  void queryClient.invalidateQueries({ queryKey: ["analytics"] })
  void queryClient.invalidateQueries({ queryKey: ["categories"] })
}

function OriginBadge({ origin }: { origin: string }) {
  if (origin === "manual") {
    return (
      <Badge variant="secondary" className="font-normal">
        manuell
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      erfunden
    </Badge>
  )
}

function CreateLabelForm() {
  const [name, setName] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const queryClient = useQueryClient()

  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const res = await fetch("/api/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      })
      const data = (await res.json()) as { error?: string; message?: string }
      if (res.status === 201) {
        toast.success(`Label "${name.trim()}" erstellt`)
        setName("")
        invalidateAll(queryClient)
      } else if (res.status === 409) {
        toast.error("Label existiert bereits")
      } else {
        toast.error("Erstellen fehlgeschlagen", {
          description: data.message ?? `HTTP ${res.status}`,
        })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex gap-2">
      <Input
        placeholder="Neues Label…"
        value={name}
        maxLength={64}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void create()
        }}
      />
      <Button disabled={busy || !name.trim()} onClick={() => void create()}>
        <Plus className="size-4" /> Hinzufügen
      </Button>
    </div>
  )
}

function RenameDialog({
  label,
  onClose,
}: {
  label: LabelRow
  onClose: () => void
}) {
  const [name, setName] = React.useState(label.name)
  const [busy, setBusy] = React.useState(false)
  const queryClient = useQueryClient()

  const rename = async () => {
    setBusy(true)
    try {
      const res = await fetch(`/api/labels/${label.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      })
      const data = (await res.json()) as { error?: string; message?: string }
      if (res.ok) {
        toast.success("Label umbenannt", { description: name.trim() })
        invalidateAll(queryClient)
        onClose()
      } else if (res.status === 409) {
        toast.error("Name bereits vergeben")
      } else {
        toast.error("Umbenennen fehlgeschlagen", {
          description: data.message ?? `HTTP ${res.status}`,
        })
      }
    } finally {
      setBusy(false)
    }
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
            if (e.key === "Enter") void rename()
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
          <Button disabled={busy || !name.trim()} onClick={() => void rename()}>
            Speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteLabelDialog({
  label,
  onClose,
}: {
  label: LabelRow
  onClose: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const queryClient = useQueryClient()

  const remove = async () => {
    setBusy(true)
    try {
      const res = await fetch(`/api/labels/${label.id}`, { method: "DELETE" })
      const data = (await res.json()) as {
        affected?: number
        error?: string
      }
      if (res.ok) {
        toast.success(`Label "${label.name}" gelöscht`, {
          description: `${data.affected ?? 0} Transaktionen werden neu kategorisiert.`,
        })
        invalidateAll(queryClient)
        onClose()
      } else {
        toast.error("Löschen fehlgeschlagen", {
          description: data.error ?? `HTTP ${res.status}`,
        })
      }
    } finally {
      setBusy(false)
    }
  }

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
            disabled={busy}
            onClick={() => void remove()}
          >
            <Trash2 className="size-4" /> Löschen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RulesList({ labelId }: { labelId: number }) {
  const { data } = useQuery<{ rules: LabelRuleRow[] }>({
    queryKey: ["label-rules", labelId],
    queryFn: async () => {
      const res = await fetch(`/api/labels/${labelId}/rules`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
  })
  const [busyId, setBusyId] = React.useState<number | null>(null)
  const queryClient = useQueryClient()

  const rules = data?.rules ?? []
  if (rules.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Keine gelernten Regeln – Regeln entstehen durch manuelle Zuweisung in
        der Transaktionstabelle.
      </p>
    )
  }

  return (
    <div className="space-y-1">
      {rules.map((rule) => (
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
          <Button
            variant="ghost"
            size="sm"
            disabled={busyId === rule.id}
            onClick={async () => {
              setBusyId(rule.id)
              try {
                const res = await fetch(`/api/label-rules/${rule.id}`, {
                  method: "DELETE",
                })
                if (res.ok) {
                  toast.success("Regel gelöscht")
                  invalidateAll(queryClient)
                } else {
                  toast.error("Löschen der Regel fehlgeschlagen")
                }
              } finally {
                setBusyId(null)
              }
            }}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  )
}

export default function LabelsPage() {
  const { data, isLoading } = useQuery<{ labels: LabelRow[] }>({
    queryKey: ["labels"],
    queryFn: async () => {
      const res = await fetch("/api/labels")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    },
  })

  const [renameTarget, setRenameTarget] = React.useState<LabelRow | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<LabelRow | null>(null)
  const [expandedId, setExpandedId] = React.useState<number | null>(null)

  const labels = data?.labels ?? []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight">
          Labels
        </h1>
        <p className="text-sm text-muted-foreground">
          Kategorien verwalten. Gelernte Regeln entstehen durch manuelle
          Zuweisung in der Transaktionsliste und schlagen passende Labels dem
          LLM vor.
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
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(label)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
                {expandedId === label.id && (
                  <div className="mt-2 border-t pt-2">
                    <RulesList labelId={label.id} />
                  </div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {renameTarget && (
        <RenameDialog
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
