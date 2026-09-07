/**
 * Single typed view of the `__dkb*` process-global flags (worker/job state,
 * instrumented guard, DB holder). Replaces the scattered
 * `globalThis as unknown as {...}` casts with one declaration.
 */
import type { Db } from "@/lib/db"

declare global {
  var __dkbInstrumented: boolean | undefined
  var __dkbLabellerWorkerStarted: boolean | undefined
}

export interface DkbGlobals {
  __dkbInstrumented?: boolean
  __dkbLabellerWorkerStarted?: boolean
  __dkbLabellerWorker?: { ticking: boolean }
  __dkbImportJob?: { running: boolean; currentBatchId: string | null }
  __dkbDbHolder?: { __dkbDb?: Db }
  __dkbTestDb?: Db
}

export function dkbGlobals(): DkbGlobals {
  return globalThis as unknown as DkbGlobals
}
