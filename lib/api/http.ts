import { NextResponse } from "next/server"

/**
 * Shared route-handler helpers: id parsing, error responses and unique-
 * constraint classification. Every error carries both a stable `error`
 * code (UI keys on it) and a German `message` (UI fallback display).
 */

/** Parse a numeric route param; null when not a positive integer. */
export function parseIdParam(raw: string): number | null {
  const id = Number.parseInt(raw, 10)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function jsonError(
  code: string,
  message: string,
  status: number,
  extra?: Record<string, unknown>
): NextResponse {
  return NextResponse.json({ error: code, message, ...extra }, { status })
}

export function badRequest(
  code = "invalid_body",
  message = "Ungültige Anfrage"
) {
  return jsonError(code, message, 400)
}

export function notFound(message = "Nicht gefunden") {
  return jsonError("not_found", message, 404)
}

export function conflict(code: string, message: string) {
  return jsonError(code, message, 409)
}

/**
 * better-sqlite3 exposes a typed code on constraint violations; this
 * replaces message-string matching ("UNIQUE constraint ...") which breaks
 * on driver wording changes or wrapping layers.
 * SQLITE_CONSTRAINT_TRIGGER is the code a RAISE(ABORT) inside a trigger
 * produces — the race-window tests simulate concurrent unique violations
 * that way, so both codes are accepted.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return false
  }
  const code = (err as { code?: unknown }).code
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_TRIGGER"
  )
}

/** Error → message without persisting "undefined" for non-Error throws. */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Route-level catch-all: maps a thrown error to a JSON 500 instead of
 * Next's non-JSON error page (the client expects JSON error envelopes).
 * Unique-constraint races that slipped past advisory pre-checks surface
 * as 409. Logs server-side, never rethrows.
 */
export async function withRoute(
  handler: () => Promise<NextResponse>
): Promise<NextResponse> {
  try {
    return await handler()
  } catch (err) {
    if (isUniqueViolation(err)) {
      return conflict("conflict", "Konflikt mit vorhandenem Datensatz")
    }
    console.error("[api] unhandled route error:", err)
    return jsonError("internal_error", toErrorMessage(err), 500)
  }
}
