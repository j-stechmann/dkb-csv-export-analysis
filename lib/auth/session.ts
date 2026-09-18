import { SignJWT, jwtVerify } from "jose"
import { getConfig } from "@/lib/config"

export const SESSION_COOKIE = "dkb_session"
export const STATE_COOKIE = "dkb_oidc_state"

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
    const secret = cfg.SESSION_SECRET ?? cfg.OIDC_CLIENT_SECRET
    cachedSecret = { key: new TextEncoder().encode(secret) }
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
    .setIssuedAt()
    .setExpirationTime(`${cfg.SESSION_TTL_SECONDS}s`)
    .sign(sessionKey())
}

export async function verifySessionToken(
  token: string
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, sessionKey(), {
      algorithms: ["HS256"],
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

export function sessionCookieOptions(): SessionCookieOptions {
  const cfg = getConfig()
  return {
    secure: cfg.APP_ORIGIN?.startsWith("https://") ?? false,
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
