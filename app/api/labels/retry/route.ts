import { NextResponse } from "next/server"
import { runLabeling } from "@/lib/labeller/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const summary = await runLabeling(["pending", "failed"])
    return NextResponse.json(summary)
  } catch (err) {
    console.error("[api/labels/retry] error:", err)
    return NextResponse.json(
      { error: "retry_failed", message: (err as Error).message },
      { status: 500 }
    )
  }
}
