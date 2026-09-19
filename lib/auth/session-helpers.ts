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
  const raw = match.slice(SESSION_COOKIE.length + 1)
  // percent-decoding can throw on malformed sequences (e.g. a stray "%") —
  // treat undecodable cookie values as absent instead of 500-ing
  let token: string | null
  try {
    token = decodeURIComponent(raw)
  } catch {
    return null
  }
  return verifySessionToken(token)
}
