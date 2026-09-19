import { getSession } from "@/lib/auth/session-helpers"
import type { SessionClaims } from "@/lib/auth/session"

/**
 * Resolves the session from the request cookie. Returns null when absent,
 * expired, or tampered (jose signature/exp checks).
 */
export async function requireSession(
  request: Request
): Promise<SessionClaims | null> {
  return getSession(request)
}

/**
 * 401 JSON for API route handlers (proxy.ts handles the page redirects).
 * The client apiFetch wrapper reacts to `unauthorized` by redirecting to
 * /auth/login.
 */
export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  })
}
