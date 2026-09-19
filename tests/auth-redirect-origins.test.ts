import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { resetOidcConfigCache } from "@/lib/auth/oidc"
import { getConfig, resetConfigCache } from "@/lib/config"

/**
 * Reverse-proxy redirect-origin regression tests (APP_ORIGIN vs Next's
 * internal request origin). The auth routes themselves are untested here —
 * these pin the origin derivation helpers and the openid-client redirect_uri
 * contract that exchangeAuthorizationCode depends on.
 */

beforeEach(() => {
  resetConfigCache()
  resetOidcConfigCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("appOrigin", () => {
  it("prefers APP_ORIGIN over the incoming request origin", async () => {
    const { appOrigin } = await import("@/lib/auth/oidc")
    expect(appOrigin("http://localhost:3000/auth/callback")).toBe(
      "https://app.example.com"
    )
  })

  it("falls back to the request origin without APP_ORIGIN", async () => {
    const prev = process.env.APP_ORIGIN
    delete process.env.APP_ORIGIN
    resetConfigCache()
    try {
      const { appOrigin } = await import("@/lib/auth/oidc")
      expect(appOrigin("http://localhost:3000/auth/callback")).toBe(
        "http://localhost:3000"
      )
    } finally {
      process.env.APP_ORIGIN = prev
      resetConfigCache()
    }
  })
})

describe("redirect_uri consistency across the OIDC flow", () => {
  it("authorize redirect_uri and token-exchange redirect_uri share the APP_ORIGIN", async () => {
    const oidc = await import("@/lib/auth/oidc")
    const cfg = getConfig()
    // the callback arrives on the internal origin (behind a reverse proxy,
    // Next sees localhost), APP_ORIGIN is the public one
    const callbackUrl =
      "http://localhost:3000/auth/callback?code=abc&state=s-123"

    // discovery fetches the issuer's well-known document — serve a minimal one
    const discoveryBody = {
      issuer: process.env.OIDC_ISSUER_URL,
      authorization_endpoint: "https://issuer.example.com/authorize",
      token_endpoint: "https://issuer.example.com/token",
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(discoveryBody), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      )
    )

    const login = await oidc.buildLoginRedirect(
      "http://localhost:3000/auth/login"
    )
    const authorizeRedirectUri =
      login.redirectUrl.searchParams.get("redirect_uri")
    expect(authorizeRedirectUri).toBe(`${cfg.APP_ORIGIN}/auth/callback`)

    // exchangeAuthorizationCode rebuilds the callback URL through
    // callbackUrlFor before handing it to openid-client (which derives
    // redirect_uri from it via stripParams). Pin that contract: the derived
    // URI must equal the authorize one, or every provider rejects with
    // invalid_grant.
    const rebuilt = oidc.callbackUrlFor(callbackUrl)
    expect(rebuilt.origin).toBe(new URL(cfg.APP_ORIGIN!).origin)
    expect(rebuilt.searchParams.get("code")).toBe("abc")
    expect(rebuilt.searchParams.get("state")).toBe("s-123")
    expect(`${rebuilt.origin}${rebuilt.pathname}`).toBe(authorizeRedirectUri)
  })

  it("trailing slashes in APP_ORIGIN do not desync the two redirect legs", async () => {
    const prev = process.env.APP_ORIGIN
    process.env.APP_ORIGIN = "https://app.example.com//"
    resetConfigCache()
    resetOidcConfigCache()
    try {
      const oidc = await import("@/lib/auth/oidc")
      const rebuilt = oidc.callbackUrlFor(
        "http://localhost:3000/auth/callback?code=abc"
      )
      const authorizeUri = `${oidc.appOrigin("http://localhost:3000/x")}/auth/callback`
      expect(`${rebuilt.origin}${rebuilt.pathname}`).toBe(authorizeUri)
      expect(rebuilt.searchParams.get("code")).toBe("abc")
    } finally {
      process.env.APP_ORIGIN = prev
      resetConfigCache()
      resetOidcConfigCache()
    }
  })

  it("sub-path APP_ORIGIN keeps the public base path in the redirect_uri", async () => {
    const prev = process.env.APP_ORIGIN
    process.env.APP_ORIGIN = "https://app.example.com/base"
    resetConfigCache()
    resetOidcConfigCache()
    try {
      const oidc = await import("@/lib/auth/oidc")
      // behind the proxy the internal path may differ — only the public
      // template path may appear in the redirect_uri
      const rebuilt = oidc.callbackUrlFor(
        "http://localhost:3000/auth/callback?code=abc&state=s-1"
      )
      expect(`${rebuilt.origin}${rebuilt.pathname}`).toBe(
        "https://app.example.com/base/auth/callback"
      )
      expect(rebuilt.searchParams.get("code")).toBe("abc")
    } finally {
      process.env.APP_ORIGIN = prev
      resetConfigCache()
      resetOidcConfigCache()
    }
  })
})

describe("sessionCookieOptions", () => {
  const ORIG = process.env.APP_ORIGIN

  afterEach(() => {
    process.env.APP_ORIGIN = ORIG
    resetConfigCache()
  })

  it("sets Secure when X-Forwarded-Proto is https, even on an internal http origin", async () => {
    delete process.env.APP_ORIGIN
    resetConfigCache()
    const { sessionCookieOptions } = await import("@/lib/auth/session")
    const opts = sessionCookieOptions(
      new Request("http://localhost:3000/auth/login", {
        headers: { "x-forwarded-proto": "https" },
      })
    )
    expect(opts.secure).toBe(true)
  })

  it("reads the first value of a comma-separated X-Forwarded-Proto", async () => {
    delete process.env.APP_ORIGIN
    resetConfigCache()
    const { sessionCookieOptions } = await import("@/lib/auth/session")
    const opts = sessionCookieOptions(
      new Request("http://localhost:3000/auth/login", {
        headers: { "x-forwarded-proto": "https, http" },
      })
    )
    expect(opts.secure).toBe(true)
  })

  it("sets Secure=false when X-Forwarded-Proto is http", async () => {
    delete process.env.APP_ORIGIN
    resetConfigCache()
    const { sessionCookieOptions } = await import("@/lib/auth/session")
    const opts = sessionCookieOptions(
      new Request("http://localhost:3000/auth/login", {
        headers: { "x-forwarded-proto": "http" },
      })
    )
    expect(opts.secure).toBe(false)
  })

  it("falls back to APP_ORIGIN when no X-Forwarded-Proto is present", async () => {
    const { sessionCookieOptions } = await import("@/lib/auth/session")
    // APP_ORIGIN is https in setup.ts; the request URL is internal http
    const opts = sessionCookieOptions(
      new Request("http://localhost:3000/auth/login", { headers: {} })
    )
    expect(opts.secure).toBe(true)
  })

  it("falls back to APP_ORIGIN when no request is passed", async () => {
    const { sessionCookieOptions } = await import("@/lib/auth/session")
    expect(sessionCookieOptions().secure).toBe(true)
  })

  it("uses the request protocol without X-Forwarded-Proto and APP_ORIGIN", async () => {
    delete process.env.APP_ORIGIN
    resetConfigCache()
    const { sessionCookieOptions } = await import("@/lib/auth/session")
    expect(
      sessionCookieOptions(new Request("https://app.example.com/auth/login"))
        .secure
    ).toBe(true)
    expect(
      sessionCookieOptions(new Request("http://localhost:3000/auth/login"))
        .secure
    ).toBe(false)
  })
})

describe("logout CSRF protection", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function postLogout(headers: Record<string, string>) {
    const { POST } = await import("@/app/auth/logout/route")
    const { NextRequest } = await import("next/server")
    const req = new NextRequest(
      new Request("http://localhost:3000/auth/logout", {
        method: "POST",
        headers,
      })
    )
    return POST(req)
  }

  it("rejects a cross-site Sec-Fetch-Site with 403", async () => {
    const res = await postLogout({
      "sec-fetch-site": "cross-site",
      origin: "https://evil.example.com",
    })
    expect(res.status).toBe(403)
  })

  it("rejects a same-site (but not same-origin) request with 403", async () => {
    const res = await postLogout({
      "sec-fetch-site": "same-site",
      origin: "https://evil.example.com",
    })
    expect(res.status).toBe(403)
  })

  it("rejects a mismatching Origin header with 403", async () => {
    const res = await postLogout({
      origin: "https://evil.example.com",
    })
    expect(res.status).toBe(403)
  })

  it("accepts a same-origin POST (Origin matches APP_ORIGIN)", async () => {
    // buildLogoutRedirect hits discovery — serve a minimal document without
    // end_session_endpoint so the route falls back to the app redirect
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              issuer: process.env.OIDC_ISSUER_URL,
              authorization_endpoint: "https://issuer.example.com/authorize",
              token_endpoint: "https://issuer.example.com/token",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          )
      )
    )
    const res = await postLogout({
      origin: "https://app.example.com",
    })
    expect(res.status).toBe(302)
    const setCookies = res.headers.getSetCookie()
    expect(setCookies.some((c) => c.startsWith("dkb_session=;"))).toBe(true)
  })

  it("accepts a request with only Sec-Fetch-Site: same-origin (no Origin)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              issuer: process.env.OIDC_ISSUER_URL,
              authorization_endpoint: "https://issuer.example.com/authorize",
              token_endpoint: "https://issuer.example.com/token",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          )
      )
    )
    const res = await postLogout({ "sec-fetch-site": "same-origin" })
    expect(res.status).toBe(302)
  })
})

describe("proxy auth gate", () => {
  it("redirects unauthenticated page requests to the APP_ORIGIN login", async () => {
    const { default: proxy } = await import("../proxy")
    const { NextRequest } = await import("next/server")
    const req = new NextRequest(
      new Request("http://localhost:3000/", { headers: {} })
    )
    const res = await proxy(req)
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location")!)
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://app.example.com/auth/login"
    )
  })

  it("returns 401 JSON for unauthenticated /api requests", async () => {
    const { default: proxy } = await import("../proxy")
    const { NextRequest } = await import("next/server")
    const req = new NextRequest(new Request("http://localhost:3000/api/labels"))
    const res = await proxy(req)
    expect(res.status).toBe(401)
  })
})

describe("sub-path APP_ORIGIN page redirects", () => {
  const ORIG = process.env.APP_ORIGIN

  function useSubPathOrigin() {
    process.env.APP_ORIGIN = "https://app.example.com/base"
    resetConfigCache()
    resetOidcConfigCache()
  }

  afterEach(() => {
    process.env.APP_ORIGIN = ORIG
    resetConfigCache()
    resetOidcConfigCache()
  })

  it("proxy gate keeps the base path in the login redirect", async () => {
    useSubPathOrigin()
    const { default: proxy } = await import("../proxy")
    const { NextRequest } = await import("next/server")
    const req = new NextRequest(
      new Request("http://localhost:3000/", { headers: {} })
    )
    const res = await proxy(req)
    expect(res.status).toBe(302)
    expect(res.headers.get("location")!).toBe(
      "https://app.example.com/base/auth/login"
    )
  })

  it("appUrl keeps the base path for app-relative targets", async () => {
    useSubPathOrigin()
    const { appUrl } = await import("@/lib/auth/oidc")
    expect(appUrl("http://localhost:3000/x", "/").toString()).toBe(
      "https://app.example.com/base/"
    )
    expect(appUrl("http://localhost:3000/x", "/auth/login").toString()).toBe(
      "https://app.example.com/base/auth/login"
    )
  })

  it("appUrl without APP_ORIGIN uses the request origin", async () => {
    delete process.env.APP_ORIGIN
    resetConfigCache()
    resetOidcConfigCache()
    const { appUrl } = await import("@/lib/auth/oidc")
    expect(appUrl("http://localhost:3000/x", "/auth/login").toString()).toBe(
      "http://localhost:3000/auth/login"
    )
  })

  it("post_logout_redirect_uri keeps the base path", async () => {
    useSubPathOrigin()
    const oidc = await import("@/lib/auth/oidc")
    const discoveryBody = {
      issuer: process.env.OIDC_ISSUER_URL,
      authorization_endpoint: "https://issuer.example.com/authorize",
      token_endpoint: "https://issuer.example.com/token",
      end_session_endpoint: "https://issuer.example.com/logout",
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(discoveryBody), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      )
    )
    const logout = await oidc.buildLogoutRedirect(
      "http://localhost:3000/auth/logout",
      null
    )
    expect(logout).not.toBeNull()
    expect(logout!.searchParams.get("post_logout_redirect_uri")).toBe(
      "https://app.example.com/base/"
    )
  })
})
