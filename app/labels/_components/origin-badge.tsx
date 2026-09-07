"use client"

import { Badge } from "@/components/ui/badge"
import type { Label } from "@/lib/api/client"

export function OriginBadge({ origin }: { origin: Label["origin"] }) {
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
