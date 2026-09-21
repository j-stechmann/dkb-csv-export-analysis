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
 * 2. Origin, when present: must match the app's origin as the browser sees
 *    it — APP_ORIGIN (reverse proxy), the request's own origin, or the
 *    Host/X-Forwarded-Host origin. A request with neither header is
 *    allowed — legacy browsers don't send either, and such requests cannot
 *    carry SameSite=Lax cookies cross-site (defense rests on SameSite
 *    there).
 *
 * The Host-derived origin matters in dev: Next normalizes request.url to
 * the server's initialized hostname (localhost), so requests arriving via
 * a LAN IP or hostname (phone testing) carry an Origin that can never
 * match request.url. Host is browser-controlled (never spoofable in the
 * flows that matter) and an attacker page's Origin can't equal the app's
 * Host, so widening the set stays safe; direct (non-browser) clients
 * can't forge the session cookie anyway.
 *
 * Callers run this after requireSession, before any state change.
 */
export function assertSameOrigin(request: Request): NextResponse | null {
  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite && fetchSite !== "same-origin") return crossSiteForbidden()
  const origin = request.headers.get("origin")
  if (!origin) return null
  // Chromium quirk observed after the OIDC round-trip: a form POST from the
  // app's own page can carry the literal "Origin: null" alongside
  // Sec-Fetch-Site: same-origin (the navigation initiator is treated as
  // opaque even though the document origin is the app's). Sec-Fetch-Site
  // can't be spoofed by an attacker page, so "null + same-origin" is a
  // legitimate browser-sent combination — accept it. "null" with a
  // cross-site/same-site Sec-Fetch-Site (sandboxed iframes etc.) was
  // already rejected above; a "null" Origin without fetch metadata rides
  // the legacy-browser allowance below (no headers at all), where
  // SameSite=Lax holds the line.
  if (origin === "null") return null
  // new URL() normalizes trailing slashes/default ports/casing that a raw
  // APP_ORIGIN string wouldn't (same pattern as the logout route's check).
  // .origin also lowercases the host — hosts are case-insensitive (RFC
  // 1035), so the comparison below must be too (e.g. Origin
  // http://Desktop:3001 vs Host-derived http://desktop:3001).
  let originNormalized: string
  try {
    originNormalized = new URL(origin).origin
  } catch {
    return crossSiteForbidden() // unparseable Origin: fail closed
  }
  const allowed = new Set([appOrigin(request.url).toLowerCase()])
  try {
    allowed.add(new URL(appUrl(request.url, "/")).origin.toLowerCase())
  } catch {
    // same-origin construction can't fail here; defensive only
  }
  // Origin as the browser sees it: X-Forwarded-Host (TLS-terminating
  // proxy) → Host, with X-Forwarded-Proto → request protocol.
  //
  // Trusted-proxy assumption: X-Forwarded-* are only meaningful when a
  // proxy in front of the app strips/overwrites client-supplied values
  // (standard proxy behavior). When the app is exposed directly, an
  // attacker page CAN set X-Forwarded-Host to its own origin — the fetch
  // forbidden-header list doesn't cover it — but that alone doesn't help
  // it: its Origin must equal the app's actual Host (it can't spoof that
  // header in browser flows), and modern browsers are already pinned by
  // the Sec-Fetch-Site check above. The residual window (same-site
  // attacker page + no Fetch Metadata + direct exposure) rests on
  // SameSite=Lax. Set APP_ORIGIN behind a proxy to pin the browser-facing
  // origin unconditionally.
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ??
    request.headers.get("host")
  if (host) {
    try {
      const proto =
        request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
        new URL(request.url).protocol.replace(/:$/, "")
      allowed.add(new URL(`${proto}://${host}`).origin.toLowerCase())
    } catch {
      // malformed Host header — nothing to add
    }
  }
  return allowed.has(originNormalized) ? null : crossSiteForbidden()
}
