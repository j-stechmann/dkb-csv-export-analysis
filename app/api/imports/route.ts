import { NextRequest, NextResponse } from "next/server"
import {
  peekAccount,
  startImport,
  isImportRunning,
  ImportInProgressError,
} from "@/lib/import/pipeline"
import { CsvParseError } from "@/lib/csv/parser"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 // 25 MB

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get("file")
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "no file provided (field name: 'file')" },
        { status: 400 }
      )
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `file too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` },
        { status: 413 }
      )
    }

    const content = await file.text()
    if (!content.trim()) {
      return NextResponse.json({ error: "file is empty" }, { status: 400 })
    }

    // synchronous preamble validation — fails before any DB write
    let account
    try {
      account = peekAccount(content)
    } catch (err) {
      const status = err instanceof CsvParseError ? 400 : 500
      return NextResponse.json(
        {
          error:
            err instanceof CsvParseError
              ? err.message
              : "failed to inspect file",
        },
        { status }
      )
    }

    const fileName = file.name || "upload.csv"
    const { batchId } = startImport(fileName, content)

    return NextResponse.json(
      {
        batchId,
        account: { name: account.accountName, iban: account.accountIban },
        snapshotDate: account.snapshotDate,
        snapshotAmountCents: account.snapshotAmountCents,
      },
      { status: 202 }
    )
  } catch (err) {
    if (err instanceof ImportInProgressError || isImportRunning()) {
      return NextResponse.json(
        { error: "import_in_progress", message: (err as Error).message },
        { status: 409 }
      )
    }
    console.error("[api/imports] error:", err)
    return NextResponse.json(
      { error: "internal_error", message: (err as Error).message },
      { status: 500 }
    )
  }
}