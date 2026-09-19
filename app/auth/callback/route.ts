import { NextRequest, NextResponse } from "next/server"
import { appUrl, exchangeAuthorizationCode } from "@/lib/auth/oidc"
import { upsertUser } from "@/lib/auth/users"
import {
  ID_TOKEN_COOKIE,
  STATE_COOKIE,
  cookieValue,
  createSessionToken,
  serializeCookie,
  sessionCookieOptions,
} from "@/lib/auth/session"
import type { SessionClaims } from "@/lib/auth/session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * OIDC redirect_uri target: verifies the state cookie, exchanges the code
 * (PKCE + nonce checked by openid-client), provisions the user and issues
 * the session cookie.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const error = url.searchParams.get("error")
  if (error) {
    return NextResponse.json(
      {
        error: "provider_error",
        message:
          url.searchParams.get("error_description") ?? "authorization failed",
      },
      { status: 401 }
    )
  }

  const state = url.searchParams.get("state")
  const code = url.searchParams.get("code")
  const expectedState = cookieValue(request.headers.get("cookie"), STATE_COOKIE)
  const verifier = cookieValue(
    request.headers.get("cookie"),
    "dkb_oidc_verifier"
  )
  const nonce = cookieValue(request.headers.get("cookie"), "dkb_oidc_nonce")
  if (
    !state ||
    !code ||
    !expectedState ||
    !verifier ||
    !nonce ||
    state !== expectedState
  ) {
    // state mismatch/absence → restart the flow, never an error echo.
    // appUrl: behind a reverse proxy request.url carries the internal
    // origin — browser-facing redirects must use the public one (and keep
    // a sub-path APP_ORIGIN).
    return NextResponse.redirect(appUrl(request.url, "/auth/login"), 302)
  }

  try {
    const result = await exchangeAuthorizationCode(
      request.url,
      state,
      nonce,
      verifier
    )
    const user = upsertUser({
      issuer: result.claims.issuer,
      subject: result.claims.subject,
      name: result.claims.name,
      email: result.claims.email,
    })
    const claims: SessionClaims = {
      uid: user.id,
      sub: user.subject,
      iss: user.issuer,
      name: user.name,
      email: user.email,
    }
    const token = await createSessionToken(claims)
    const opts = sessionCookieOptions(request)
    const res = NextResponse.redirect(appUrl(request.url, "/"), 302)
    res.headers.append(
      "set-cookie",
      serializeCookie("dkb_session", token, opts)
    )
    // flow cookies are single-use; the id_token is kept for RP-initiated
    // logout (id_token_hint)
    res.headers.append(
      "set-cookie",
      serializeCookie(STATE_COOKIE, "", { ...opts, maxAgeSeconds: 0 })
    )
    res.headers.append(
      "set-cookie",
      serializeCookie("dkb_oidc_verifier", "", { ...opts, maxAgeSeconds: 0 })
    )
    res.headers.append(
      "set-cookie",
      serializeCookie("dkb_oidc_nonce", "", { ...opts, maxAgeSeconds: 0 })
    )
    if (result.idToken) {
      res.headers.append(
        "set-cookie",
        serializeCookie(ID_TOKEN_COOKIE, result.idToken, {
          ...opts,
          maxAgeSeconds: opts.maxAgeSeconds,
        })
      )
    }
    return res
  } catch (err) {
    // provider/token-endpoint failure details go to the server log only —
    // openid-client errors can carry internal issuer/token-endpoint URLs
    console.error("[auth/callback] error:", err)
    return NextResponse.json(
      {
        error: "exchange_failed",
        message: "authorization code exchange failed",
      },
      { status: 401 }
    )
  }
}
