import { NextRequest, NextResponse } from "next/server"
import {
  assertSameOrigin,
  requireSession,
  unauthorized,
} from "@/lib/auth/guard"
import { resetFailedLabels } from "@/lib/import/pipeline"
import { getConfig } from "@/lib/config"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Fire-and-forget: re-enqueue failed rows for the label worker.
 * Batches are not re-touched; the worker picks the rows up within a tick
 * and their batch counters self-heal (counters are computed on read).
 */
export async function POST(request: NextRequest) {
  const session = await requireSession(request)
  if (!session) return unauthorized()
  const csrf = assertSameOrigin(request)
  if (csrf) return csrf
  try {
    const queued = resetFailedLabels(getConfig().LLM_MAX_ATTEMPTS, session.uid)
    return NextResponse.json({ queued }, { status: 202 })
  } catch (err) {
    console.error("[api/labels/retry] error:", err)
    return NextResponse.json(
      { error: "retry_failed", message: (err as Error).message },
      { status: 500 }
    )
  }
}
