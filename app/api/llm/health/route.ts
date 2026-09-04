import { NextResponse } from "next/server"
import { LlmClient } from "@/lib/llm/client"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const client = new LlmClient()
  const health = await client.health()
  return NextResponse.json({ status: health })
}
