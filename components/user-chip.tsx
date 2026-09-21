"use client"

import { LogOut } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SessionUser } from "@/components/user-session"
import { useSessionUser } from "@/components/user-session"

export function UserChip({
  user,
  className,
}: {
  user: SessionUser
  className?: string
}) {
  const label = user.name || user.email || "Angemeldet"
  return (
    <div className={cn("flex items-center gap-2", className)}>
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

/**
 * Desktop-only chip for the header's right side. On mobile (< sm) the sheet
 * in mobile-nav.tsx carries the user info and logout instead.
 */
export function HeaderUserChip() {
  const user = useSessionUser()
  if (!user) return null
  return <UserChip user={user} className="hidden sm:flex" />
}
