import { NextResponse } from "next/server"
import { LabellerClient } from "@/lib/labeller/client"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const client = new LabellerClient()
  const health = await client.health()
  return NextResponse.json({ status: health })
}
