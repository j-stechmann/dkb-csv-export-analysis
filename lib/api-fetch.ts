"use client"

/**
 * fetch wrapper: a 401 (expired/tampered session) bounces the browser to
 * /auth/login to start a fresh OIDC round-trip. All API calls go through
 * this so a mid-session expiry recovers without a manual reload.
 */
export async function apiFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(input, init)
  if (res.status === 401) {
    const ct = res.headers.get("content-type") ?? ""
    if (ct.includes("application/json")) {
      window.location.href = "/auth/login"
    }
  }
  return res
}
