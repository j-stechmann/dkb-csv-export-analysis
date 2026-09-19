import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { resetConfigCache } from "@/lib/config"
import { assertSameOrigin, unauthorized } from "@/lib/auth/guard"
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session"
import { getSession } from "@/lib/auth/session-helpers"
import { cookieValue, STATE_COOKIE } from "@/lib/auth/session"
import { resetSessionSecretCache } from "@/lib/auth/session"

/**
 * Tests for the shared mutating-route CSRF guard (assertSameOrigin) and the
 * hardened cookie readers (percent-decode failures become null, not throws).
 */

beforeEach(() => {
  resetConfigCache()
  resetSessionSecretCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function req(
  url: string,
  headers: Record<string, string> = {},
  method = "POST"
): Request {
  return new Request(url, { method, headers })
}

describe("assertSameOrigin", () => {
  it("rejects cross-site Sec-Fetch-Site with 403 cross_site_request_rejected", () => {
    const res = assertSameOrigin(
      req("https://app.example.com/api/labels", {
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example.com",
      })
    )
    expect(res!.status).toBe(403)
    void expect(res!.body).toBeTruthy()
  })

  it("rejects same-site (but not same-origin) fetches with 403", () => {
    const res = assertSameOrigin(
      req("https://app.example.com/api/labels", {
        "sec-fetch-site": "same-site",
        origin: "https://evil.example.com",
      })
    )
    expect(res!.status).toBe(403)
  })

  it("rejects a mismatching Origin with 403", () => {
    const res = assertSameOrigin(
      req("https://app.example.com/api/labels", {
        origin: "https://evil.example.com",
      })
    )
    expect(res!.status).toBe(403)
  })

  it("accepts a matching Origin (APP_ORIGIN wins over the request origin)", () => {
    // request arrives on the internal origin behind a reverse proxy; the
    // browser-facing APP_ORIGIN is the one the Origin header carries
    const res = assertSameOrigin(
      req("http://localhost:3000/api/labels", {
        origin: "https://app.example.com",
      })
    )
    expect(res).toBeNull()
  })

  it("accepts a request origin match without APP_ORIGIN", () => {
    const prev = process.env.APP_ORIGIN
    delete process.env.APP_ORIGIN
    resetConfigCache()
    try {
      const res = assertSameOrigin(
        req("https://app.example.com/api/labels", {
          origin: "https://app.example.com",
        })
      )
      expect(res).toBeNull()
    } finally {
      process.env.APP_ORIGIN = prev
      resetConfigCache()
    }
  })

  it("accepts same-origin Sec-Fetch-Site without an Origin header", () => {
    const res = assertSameOrigin(
      req("https://app.example.com/api/labels", {
        "sec-fetch-site": "same-origin",
      })
    )
    expect(res).toBeNull()
  })

  it("allows requests carrying neither header (legacy browsers; SameSite holds the line)", () => {
    const res = assertSameOrigin(req("https://app.example.com/api/labels"))
    expect(res).toBeNull()
  })

  it("normalizes trailing slashes and default ports in APP_ORIGIN", () => {
    const prev = process.env.APP_ORIGIN
    process.env.APP_ORIGIN = "https://app.example.com/"
    resetConfigCache()
    try {
      const res = assertSameOrigin(
        req("http://localhost:3000/api/labels", {
          origin: "https://app.example.com",
        })
      )
      expect(res).toBeNull()
    } finally {
      process.env.APP_ORIGIN = prev
      resetConfigCache()
    }
  })
})

describe("cookie decode hardening", () => {
  it("getSession returns null instead of throwing on a malformed cookie value", async () => {
    const token = await createSessionToken({
      uid: 1,
      sub: "user-1",
      iss: "https://issuer.example.com",
      name: "T",
      email: "t@example.com",
    })
    // a raw "%" breaks decodeURIComponent; a valid token still verifies
    const bad = new Request("http://test/api/x", {
      headers: { cookie: `${SESSION_COOKIE}=%` },
    })
    expect(await getSession(bad)).toBeNull()
    const good = new Request("http://test/api/x", {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    })
    expect(await getSession(good)).not.toBeNull()
  })

  it("cookieValue returns null on malformed sequences instead of throwing", () => {
    expect(cookieValue(`${STATE_COOKIE}=%ZZ`, STATE_COOKIE)).toBeNull()
    expect(cookieValue(`${STATE_COOKIE}=abc%2Bdef`, STATE_COOKIE)).toBe(
      "abc+def"
    )
    expect(cookieValue(null, STATE_COOKIE)).toBeNull()
  })

  it("unauthorized() keeps the documented 401 JSON shape", () => {
    const res = unauthorized()
    expect(res.status).toBe(401)
  })
})
