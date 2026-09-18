import { NextRequest, NextResponse } from "next/server"
import { buildLogoutRedirect } from "@/lib/auth/oidc"
import {
  STATE_COOKIE,
  clearCookie,
  sessionCookieOptions,
} from "@/lib/auth/session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Clears the session cookie; when the provider advertises an
 * end_session_endpoint, the browser is sent there afterwards (RP-initiated
 * logout with post_logout_redirect_uri back to /).
 */
export async function GET(request: NextRequest) {
  const opts = sessionCookieOptions()
  const providerLogout = await buildLogoutRedirect(request.url, null)
  const res = providerLogout
    ? NextResponse.redirect(providerLogout.toString(), 302)
    : NextResponse.redirect(new URL("/", request.url), 302)
  res.headers.append("set-cookie", clearCookie("dkb_session", opts))
  res.headers.append(
    "set-cookie",
    clearCookie(STATE_COOKIE, { ...opts, maxAgeSeconds: 0 })
  )
  return res
}
