import { NextRequest, NextResponse } from "next/server"
import { buildLoginRedirect } from "@/lib/auth/oidc"
import { assertSameOrigin } from "@/lib/auth/guard"
import {
  STATE_COOKIE,
  clearCookie,
  serializeCookie,
  sessionCookieOptions,
} from "@/lib/auth/session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Starts the OIDC authorization-code flow: PKCE + state, state stored in a
 * short-lived HttpOnly cookie (CSRF protection) and verified at the callback.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await buildLoginRedirect(request.url)
    // Secure from the forwarded protocol/APP_ORIGIN: behind a reverse proxy
    // request.url carries the internal (often http) origin, while the browser
    // sees https.
    const opts = sessionCookieOptions(request)
    const flowOpts = { secure: opts.secure, maxAgeSeconds: 600 }
    const res = NextResponse.redirect(auth.redirectUrl.toString(), 302)
    res.headers.append(
      "set-cookie",
      serializeCookie(STATE_COOKIE, auth.state, flowOpts)
    )
    res.headers.append(
      "set-cookie",
      serializeCookie("dkb_oidc_verifier", auth.codeVerifier, flowOpts)
    )
    res.headers.append(
      "set-cookie",
      serializeCookie("dkb_oidc_nonce", auth.nonce, flowOpts)
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

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  // stray state cookies never hurt; provided for completeness (still guarded
  // for consistency with the other mutating handlers)
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
  const opts = sessionCookieOptions()
  return new NextResponse(null, {
    status: 204,
    headers: {
      "set-cookie": clearCookie(STATE_COOKIE, {
        secure: opts.secure,
        maxAgeSeconds: 0,
      }),
    },
  })
}
