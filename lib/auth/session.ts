import { SignJWT, jwtVerify } from "jose"
import { getConfig } from "@/lib/config"

export const SESSION_COOKIE = "dkb_session"
export const STATE_COOKIE = "dkb_oidc_state"
/** id_token from the last exchange — sent as id_token_hint at RP logout. */
export const ID_TOKEN_COOKIE = "dkb_id_token"

export interface SessionClaims {
  /** users.id (internal numeric key) */
  uid: number
  /** OIDC subject */
  sub: string
  /** OIDC issuer */
  iss: string
  name: string
  email: string
}

interface SessionSecret {
  key: Uint8Array
}

let cachedSecret: SessionSecret | null = null

/** HS256 key from SESSION_SECRET, falling back to OIDC_CLIENT_SECRET. */
function sessionKey(): Uint8Array {
  if (!cachedSecret) {
    const cfg = getConfig()
    if (cfg.SESSION_SECRET) {
      cachedSecret = { key: new TextEncoder().encode(cfg.SESSION_SECRET) }
    } else {
      // same minimum as SESSION_SECRET (32 chars): the client secret is
      // otherwise allowed at any length and would silently weaken HS256
      // (it also already serves provider auth — one secret, two purposes)
      if (cfg.OIDC_CLIENT_SECRET.length < 32) {
        throw new Error(
          "SESSION_SECRET is unset and OIDC_CLIENT_SECRET is shorter than " +
            "32 chars — set SESSION_SECRET (≥32 chars) explicitly"
        )
      }
      console.warn(
        "[auth/session] SESSION_SECRET unset — falling back to " +
          "OIDC_CLIENT_SECRET as the HS256 key (dedicated SESSION_SECRET " +
          "recommended)"
      )
      cachedSecret = { key: new TextEncoder().encode(cfg.OIDC_CLIENT_SECRET) }
    }
  }
  return cachedSecret.key
}

/** For tests: drop the memoized key (config is reset between cases). */
export function resetSessionSecretCache() {
  cachedSecret = null
}

export async function createSessionToken(
  claims: SessionClaims
): Promise<string> {
  const cfg = getConfig()
  return new SignJWT({
    uid: claims.uid,
    name: claims.name,
    email: claims.email,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(claims.iss)
    .setAudience("dkb-csv-export-analysis")
    .setIssuedAt()
    .setExpirationTime(`${cfg.SESSION_TTL_SECONDS}s`)
    .sign(sessionKey())
}

export async function verifySessionToken(
  token: string
): Promise<SessionClaims | null> {
  try {
    const cfg = getConfig()
    const { payload } = await jwtVerify(token, sessionKey(), {
      algorithms: ["HS256"],
      audience: "dkb-csv-export-analysis",
      issuer: cfg.OIDC_ISSUER_URL,
    })
    if (
      typeof payload.sub !== "string" ||
      typeof payload.iss !== "string" ||
      typeof payload.uid !== "number" ||
      !Number.isInteger(payload.uid)
    ) {
      return null
    }
    return {
      uid: payload.uid,
      sub: payload.sub,
      iss: payload.iss,
      name: typeof payload.name === "string" ? payload.name : "",
      email: typeof payload.email === "string" ? payload.email : "",
    }
  } catch {
    return null
  }
}

export interface SessionCookieOptions {
  secure: boolean
  maxAgeSeconds: number
}

export function sessionCookieOptions(request?: Request): SessionCookieOptions {
  const cfg = getConfig()
  // Secure must reflect what the browser sees, not Next's internal origin.
  // Precedence mirrors the CSRF guard's proxy-trust rule (lib/auth/guard.ts):
  // X-Forwarded-Proto is trusted only when APP_ORIGIN is set (the proxy
  // declaration — without it the header is client-settable via fetch()) →
  // APP_ORIGIN (documented requirement for proxied deployments; request.url
  // carries the internal http origin there) → the request's own protocol
  // (direct TLS).
  const behindProxy = Boolean(cfg.APP_ORIGIN)
  const forwarded = behindProxy
    ? request?.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
    : undefined
  const secure = forwarded
    ? forwarded === "https"
    : cfg.APP_ORIGIN
      ? cfg.APP_ORIGIN.startsWith("https://")
      : new URL(request?.url ?? "http://localhost").protocol === "https:"
  return {
    secure,
    maxAgeSeconds: cfg.SESSION_TTL_SECONDS,
  }
}

export function serializeCookie(
  name: string,
  value: string,
  options: SessionCookieOptions & { maxAgeSeconds?: number }
): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"]
  if (options.secure) parts.push("Secure")
  parts.push(`Max-Age=${options.maxAgeSeconds}`)
  return parts.join("; ")
}

export function clearCookie(
  name: string,
  options: SessionCookieOptions
): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${
    options.secure ? "; Secure" : ""
  }`
}

/**
 * Read one cookie value from a Cookie header (percent-decoded, null on a
 * malformed sequence). Shared by the auth routes — serializeCookie writes
 * percent-encoded session tokens and raw base64url flow values, both of
 * which survive the round-trip.
 */
export function cookieValue(
  header: string | null,
  name: string
): string | null {
  if (!header) return null
  const match = header
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
  if (!match) return null
  try {
    return decodeURIComponent(match.slice(name.length + 1))
  } catch {
    return null
  }
}
