import { NextRequest, NextResponse } from "next/server"
import { appOrigin, appUrl, buildLogoutRedirect } from "@/lib/auth/oidc"
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
 * POST-only with an Origin/Sec-Fetch-Site check: cross-site POSTs are
 * rejected before any state changes, which eliminates logout CSRF (the
 * check needs the request itself, so it can't be forged by a cross-site
 * form — browsers always attach Origin to POSTs and it can't be spoofed
 * by attacker-controlled pages).
 */
export async function POST(request: NextRequest) {
  // CSRF check: browsers attach Origin to every POST submission and
  // Sec-Fetch-Site to every fetch-driven one. A cross-site attacker page can
  // trigger this route but cannot forge either header value.
  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite && fetchSite !== "same-origin") {
    return NextResponse.json(
      { error: "cross_site_logout_rejected" },
      { status: 403 }
    )
  }
  const origin = request.headers.get("origin")
  if (origin) {
    const allowed = new Set([appOrigin(request.url)])
    try {
      allowed.add(new URL(appUrl(request.url, "/")).origin)
    } catch {
      // appUrl can't produce anything new here (same origin); defensive only
    }
    if (!allowed.has(origin)) {
      return NextResponse.json(
        { error: "cross_site_logout_rejected" },
        { status: 403 }
      )
    }
  }
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
