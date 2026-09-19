import { getSession } from "@/lib/auth/session-helpers"
import type { SessionClaims } from "@/lib/auth/session"
import { NextResponse } from "next/server"
import { appOrigin, appUrl } from "@/lib/auth/oidc"

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

/**
 * 403 JSON for a rejected cross-site state-changing request (see
 * assertSameOrigin).
 */
function crossSiteForbidden(): NextResponse {
  return NextResponse.json(
    { error: "cross_site_request_rejected" },
    { status: 403 }
  )
}

/**
 * CSRF guard for mutating (non-GET) API routes, shared with /auth/logout's
 * check: browsers attach Sec-Fetch-Site to every fetch-driven request and
 * Origin to every non-GET submission, and neither can be spoofed by an
 * attacker-controlled page. SameSite=Lax already blocks classic cross-site
 * form POSTs; this closes the remaining same-site-cross-origin gap (cookies
 * ARE attached for a cross-origin fetch within the same registrable site,
 * e.g. behind a shared reverse proxy).
 *
 * Order of checks:
 * 1. Sec-Fetch-Site, when present: only same-origin passes.
 * 2. Origin, when present: must match the app's origin (APP_ORIGIN or the
 *    request's own). A request with neither header is allowed — legacy
 *    browsers don't send either, and such requests cannot carry SameSite=Lax
 *    cookies cross-site (defense rests on SameSite there).
 *
 * Callers run this after requireSession, before any state change.
 */
export function assertSameOrigin(request: Request): NextResponse | null {
  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite && fetchSite !== "same-origin") return crossSiteForbidden()
  const origin = request.headers.get("origin")
  if (!origin) return null
  // new URL() normalizes trailing slashes/default ports/casing that a raw
  // APP_ORIGIN string wouldn't (same pattern as the logout route's check)
  const allowed = new Set([appOrigin(request.url)])
  try {
    allowed.add(new URL(appUrl(request.url, "/")).origin)
  } catch {
    // same-origin construction can't fail here; defensive only
  }
  return allowed.has(origin) ? null : crossSiteForbidden()
}
