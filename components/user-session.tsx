"use client"

import { useEffect, useState } from "react"

export interface SessionUser {
  name: string
  email: string
}

/**
 * Client-side mirror of the server session. proxy.ts gates the routes; this
 * only feeds the header chip (name/email), so a null response simply renders
 * nothing — it can never unblock a gated page.
 */
export function useSessionUser(): SessionUser | null {
  const [user, setUser] = useState<SessionUser | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch("/api/me")
        if (!res.ok) return
        const data = (await res.json()) as { user?: SessionUser }
        if (alive) setUser(data.user ?? null)
      } catch {
        // offline / shutting down: chip stays empty
      }
    })()
    return () => {
      alive = false
    }
  }, [])
  return user
}
