"use client"

import { useQuery } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"

export function LabellerHealthBadge() {
  const { data } = useQuery<{ status: "ok" | "degraded" | "unreachable" }>({
    queryKey: ["labeller-health"],
    queryFn: async () => {
      const res = await fetch("/api/labeller/health")
      if (!res.ok) return { status: "unreachable" as const }
      return res.json()
    },
    refetchInterval: 30_000,
  })

  const status = data?.status ?? "unreachable"
  const label =
    status === "ok"
      ? "Labeller: verbunden"
      : status === "degraded"
        ? "Labeller: eingeschränkt"
        : "Labeller: nicht erreichbar"
  const variant =
    status === "ok" ? "default" : status === "degraded" ? "secondary" : "destructive"

  return (
    <Badge variant={variant} className="font-normal">
      {label}
    </Badge>
  )
}