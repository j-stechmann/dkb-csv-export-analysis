import { NextResponse, type NextRequest } from "next/server"
import { getSession } from "@/lib/auth/session-helpers"

/**
 * Auth gate (Next 16 proxy convention — middleware.ts is deprecated).
 * Node runtime by default, so jose is fine here; better-sqlite3 stays out
 * (no lib/db import — session verification is stateless JWT only).
 *
 * Pages without a session → /auth/login; /api/* without a session → 401
 * JSON (the client apiFetch wrapper redirects to /auth/login). The health
 * endpoint stays open for the Docker HEALTHCHECK (ADR-0028).
 */
const PUBLIC_PATHS = [
  "/auth/login",
  "/auth/callback",
  "/auth/logout",
  "/api/llm/health",
]

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  )
}

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (isPublic(pathname)) return NextResponse.next()

  const session = await getSession(request)
  if (session) return NextResponse.next()

  if (pathname.startsWith("/api/")) {
    return new NextResponse(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  }
  const loginUrl = new URL("/auth/login", request.url)
  return NextResponse.redirect(loginUrl.toString(), 302)
}

export const config = {
  // everything except Next internals, static assets, and public files
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|css|js|map|woff|woff2)$).*)",
  ],
}
