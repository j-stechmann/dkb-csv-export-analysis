"use client"

import { Button } from "@/components/ui/button"

export function ErrorState({
  onRetry,
  className,
}: {
  onRetry: () => void
  className?: string
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 ${className ?? ""}`}
    >
      <p className="text-sm text-destructive">
        Daten konnten nicht geladen werden.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Erneut versuchen
      </Button>
    </div>
  )
}
