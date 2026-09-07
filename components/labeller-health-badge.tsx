"use client"

import { Badge } from "@/components/ui/badge"
import { useLlmHealth } from "@/hooks/use-queries"

export function LabellerHealthBadge() {
  const { data } = useLlmHealth()

  const status = data ?? "unreachable"
  const label =
    status === "ok"
      ? "LLM: verbunden"
      : status === "degraded"
        ? "LLM: eingeschränkt"
        : "LLM: nicht erreichbar"
  const variant =
    status === "ok"
      ? "default"
      : status === "degraded"
        ? "secondary"
        : "destructive"

  return (
    <Badge variant={variant} className="font-normal">
      {label}
    </Badge>
  )
}
