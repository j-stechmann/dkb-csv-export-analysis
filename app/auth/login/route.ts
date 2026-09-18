import { NextRequest, NextResponse } from "next/server"
import { buildLoginRedirect } from "@/lib/auth/oidc"
import { STATE_COOKIE, clearCookie, serializeCookie } from "@/lib/auth/session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Starts the OIDC authorization-code flow: PKCE + state, state stored in a
 * short-lived HttpOnly cookie (CSRF protection) and verified at the callback.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await buildLoginRedirect(request.url)
    const secure = new URL(request.url).protocol === "https:"
    const res = NextResponse.redirect(auth.redirectUrl.toString(), 302)
    res.headers.append(
      "set-cookie",
      serializeCookie(STATE_COOKIE, auth.state, {
        secure,
        maxAgeSeconds: 600,
      })
    )
    res.headers.append(
      "set-cookie",
      serializeCookie("dkb_oidc_verifier", auth.codeVerifier, {
        secure,
        maxAgeSeconds: 600,
      })
    )
    res.headers.append(
      "set-cookie",
      serializeCookie("dkb_oidc_nonce", auth.nonce, {
        secure,
        maxAgeSeconds: 600,
      })
    )
    return res
  } catch (err) {
    console.error("[auth/login] error:", err)
    return NextResponse.json(
      {
        error: "login_failed",
        message: "OIDC provider unreachable or misconfigured",
      },
      { status: 502 }
    )
  }
}

export async function DELETE(request: NextRequest) {
  // stray state cookies never hurt; provided for completeness
  const secure = new URL(request.url).protocol === "https:"
  return new NextResponse(null, {
    status: 204,
    headers: {
      "set-cookie": clearCookie(STATE_COOKIE, { secure, maxAgeSeconds: 0 }),
    },
  })
}
