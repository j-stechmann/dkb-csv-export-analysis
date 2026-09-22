import { NextRequest, NextResponse } from "next/server"
import { appUrl, buildLogoutRedirect } from "@/lib/auth/oidc"
import { assertSameOrigin } from "@/lib/auth/guard"
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
 * POST-only with the shared Origin/Sec-Fetch-Site CSRF guard
 * (lib/auth/guard.ts assertSameOrigin): cross-site POSTs are rejected before
 * any state changes, which eliminates logout CSRF (the check needs the
 * request itself, so it can't be forged by a cross-site form — browsers
 * always attach Origin to POSTs and it can't be spoofed by
 * attacker-controlled pages).
 */
export async function POST(request: NextRequest) {
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
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
  res.headers.append("set-cookie", clearCookie("geldlage_session", opts))
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
