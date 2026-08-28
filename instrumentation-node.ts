/**
 * Node.js-only instrumentation (schema init + recovery + relabel sweep).
 * Imported conditionally from instrumentation.ts so the Edge bundle never
 * touches better-sqlite3.
 */
export async function registerNode() {
  const g = globalThis as unknown as { __dkbInstrumented?: boolean }
  if (g.__dkbInstrumented) return
  g.__dkbInstrumented = true

  const { ensureSchema } = await import("@/lib/db")
  const {
    resetStuckBatches,
  } = await import("@/lib/import/pipeline")
  const { runLabeling } = await import("@/lib/labeller/service")
  const { LabellerClient } = await import("@/lib/labeller/client")

  try {
    ensureSchema()
    const stuck = resetStuckBatches()
    if (stuck > 0) {
      console.log(`[startup] reset ${stuck} stuck import batch(es) to failed`)
    }
  } catch (err) {
    console.error("[startup] schema/recovery failed:", err)
  }

  async function relabelSweep(): Promise<void> {
    const state = globalThis as unknown as {
      __dkbImportJob?: { running: boolean }
    }
    if (state.__dkbImportJob?.running) return // import owns the DB pipeline

    try {
      const client = new LabellerClient()
      const health = await client.health()
      if (health !== "ok") return

      await runLabeling(["pending", "failed"], 500)
    } catch (err) {
      console.error("[relabel sweep] error:", err)
    }
  }

  // initial sweep shortly after boot (self-heal after downtime)
  const initialTimer = setTimeout(() => {
    void relabelSweep()
  }, 3000)
  initialTimer.unref?.()

  // periodic self-heal for late labeller recovery
  const interval = setInterval(() => {
    void relabelSweep()
  }, 60_000)
  interval.unref?.()
}