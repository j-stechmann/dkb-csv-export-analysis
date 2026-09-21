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
let sessionUserPromise: Promise<SessionUser | null> | undefined

async function fetchSessionUser(): Promise<SessionUser | null> {
  try {
    const res = await fetch("/api/me")
    if (!res.ok) return null
    const data = (await res.json()) as { user?: SessionUser }
    return data.user ?? null
  } catch {
    // offline / shutting down: chip stays empty
    return null
  }
}

export function useSessionUser(): SessionUser | null {
  const [user, setUser] = useState<SessionUser | null>(null)
  useEffect(() => {
    let alive = true
    // Memoize only a successful fetch: a transient /api/me failure (dev
    // server restart, offline moment) must stay retryable by the next
    // component mount, so the empty result isn't cached for the tab's
    // lifetime.
    sessionUserPromise ??= fetchSessionUser().then((data) => {
      if (data) return data
      sessionUserPromise = undefined
      return data
    })
    void sessionUserPromise.then((data) => {
      if (alive) setUser(data)
    })
    return () => {
      alive = false
    }
  }, [])
  return user
}
