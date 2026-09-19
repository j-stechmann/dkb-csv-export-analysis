"use client"

import { LogOut } from "lucide-react"
import type { SessionUser } from "@/components/user-session"

export function UserChip({ user }: { user: SessionUser }) {
  const label = user.name || user.email || "Angemeldet"
  return (
    <div className="flex items-center gap-2">
      <span
        className="hidden max-w-40 truncate text-sm text-muted-foreground md:inline"
        title={user.email}
      >
        {label}
      </span>
      <form action="/auth/logout" method="post">
        <button
          type="submit"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Abmelden"
        >
          <LogOut className="size-4" />
          <span className="hidden md:inline">Abmelden</span>
        </button>
      </form>
    </div>
  )
}
