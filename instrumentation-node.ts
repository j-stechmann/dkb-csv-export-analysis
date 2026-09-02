/**
 * Node.js-only instrumentation (schema init + recovery + label worker).
 * Imported conditionally from instrumentation.ts so the Edge bundle never
 * touches better-sqlite3.
 */
export async function registerNode() {
  const g = globalThis as unknown as { __dkbInstrumented?: boolean }
  if (g.__dkbInstrumented) return
  g.__dkbInstrumented = true

  const { ensureSchema } = await import("@/lib/db")
  const { resetStuckBatches } = await import("@/lib/import/pipeline")
  const { startLabelWorker } = await import("@/lib/labeller/worker")

  try {
    ensureSchema()
    const stuck = resetStuckBatches()
    if (stuck > 0) {
      console.log(`[startup] reset ${stuck} stuck import batch(es) to failed`)
    }
  } catch (err) {
    console.error("[startup] schema/recovery failed:", err)
  }

  // label worker resumes 'labeling' batches after a restart and drains
  // pending/failed rows; first tick shortly after boot (self-heal)
  startLabelWorker()
}
