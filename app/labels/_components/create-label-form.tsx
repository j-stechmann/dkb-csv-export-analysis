"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useCreateLabel } from "@/hooks/use-mutations"

export function CreateLabelForm() {
  const [name, setName] = React.useState("")
  const create = useCreateLabel()

  const submit = () => {
    if (!name.trim()) return
    create.mutate(
      { name: name.trim() },
      {
        onSuccess: () => setName(""),
      }
    )
  }

  return (
    <div className="flex gap-2">
      <Input
        placeholder="Neues Label…"
        value={name}
        maxLength={64}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit()
        }}
      />
      <Button disabled={create.isPending || !name.trim()} onClick={submit}>
        <Plus className="size-4" /> Hinzufügen
      </Button>
    </div>
  )
}
