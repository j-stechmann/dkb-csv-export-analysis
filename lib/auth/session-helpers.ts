import {
  SESSION_COOKIE,
  verifySessionToken,
  type SessionClaims,
} from "@/lib/auth/session"

/**
 * Resolves the session from the request cookie. Returns null when absent,
 * expired, or tampered (jose signature/exp checks).
 */
export async function getSession(
  request: Request
): Promise<SessionClaims | null> {
  const header = request.headers.get("cookie") ?? ""
  const match = header
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  if (!match) return null
  const token = decodeURIComponent(match.slice(SESSION_COOKIE.length + 1))
  return verifySessionToken(token)
}
