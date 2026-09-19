"use client"

import { useQuery } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { apiFetch } from "@/lib/api-fetch"

type Status = "ok" | "degraded" | "unreachable"

const STATUS_TEXT: Record<Status, string> = {
  ok: "verbunden",
  degraded: "eingeschränkt",
  unreachable: "nicht erreichbar",
}

const STATUS_VARIANT: Record<Status, "default" | "secondary" | "destructive"> =
  {
    ok: "default",
    degraded: "secondary",
    unreachable: "destructive",
  }

export function LabellerHealthBadge() {
  const { data } = useQuery<{ status: Status }>({
    queryKey: ["llm-health"],
    queryFn: async () => {
      const res = await apiFetch("/api/llm/health")
      if (!res.ok) return { status: "unreachable" as const }
      return res.json()
    },
    refetchInterval: 30_000,
  })

  const status: Status =
    data?.status === "ok" || data?.status === "degraded"
      ? data.status
      : "unreachable"
  const label = `LLM: ${STATUS_TEXT[status]}`
  const variant = STATUS_VARIANT[status]

  return (
    <Badge variant={variant} className="font-normal">
      <span className="md:hidden">
        LLM<span className="sr-only">: {STATUS_TEXT[status]}</span>
      </span>
      <span className="hidden md:inline">{label}</span>
    </Badge>
  )
}
