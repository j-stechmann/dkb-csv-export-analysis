import { NextRequest, NextResponse } from "next/server"
import { appUrl, buildLogoutRedirect } from "@/lib/auth/oidc"
import {
  ID_TOKEN_COOKIE,
  STATE_COOKIE,
  clearCookie,
  cookieValue,
  sessionCookieOptions,
} from "@/lib/auth/session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Clears the session cookie; when the provider advertises an
 * end_session_endpoint, the browser is sent there afterwards (RP-initiated
 * logout with id_token_hint and post_logout_redirect_uri back to /).
 *
 * POST-only: a state-changing GET lets a cross-site link or prefetch log the
 * victim out (SameSite=Lax still sends the cookie on top-level navigation).
 * A cross-site form POST remains possible, so this reduces — not eliminates
 * — logout CSRF (nuisance-level).
 */
export async function POST(request: NextRequest) {
  const opts = sessionCookieOptions(request)
  const idToken = cookieValue(request.headers.get("cookie"), ID_TOKEN_COOKIE)
  const providerLogout = await buildLogoutRedirect(request.url, idToken)
  // appUrl: behind a reverse proxy request.url carries the internal
  // origin — browser-facing redirects must use the public one (and keep a
  // sub-path APP_ORIGIN).
  const fallback = appUrl(request.url, "/")
  const res = providerLogout
    ? NextResponse.redirect(providerLogout.toString(), 302)
    : NextResponse.redirect(fallback, 302)
  res.headers.append("set-cookie", clearCookie("dkb_session", opts))
  res.headers.append(
    "set-cookie",
    clearCookie(STATE_COOKIE, { ...opts, maxAgeSeconds: 0 })
  )
  res.headers.append(
    "set-cookie",
    clearCookie(ID_TOKEN_COOKIE, { ...opts, maxAgeSeconds: 0 })
  )
  return res
}
