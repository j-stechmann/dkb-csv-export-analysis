/**
 * Shared import-progress math + German stage labels for the progress pill
 * and the imports page (single source — the copies had drifted).
 */
import type { ImportBatchState, ImportStage } from "@/lib/api/client"

export const STAGE_LABELS: Record<ImportStage, string> = {
  parsing: "CSV wird gelesen…",
  importing: "Transaktionen werden gespeichert…",
  labeling: "Kategorien werden ermittelt…",
  completed: "Import abgeschlossen",
  failed: "Import fehlgeschlagen",
}

export function labelProgress(batch: ImportBatchState): number {
  if (batch.labelsTotal > 0) {
    return Math.round(
      ((batch.labelsDone + batch.labelsFailed) / batch.labelsTotal) * 100
    )
  }
  return batch.status === "labeling" ? 0 : 100
}

export function rowProgress(batch: ImportBatchState): number {
  if (batch.rowsTotal > 0) {
    return Math.round(
      ((batch.rowsImported + batch.rowsDuplicate + batch.rowsUpdated) /
        batch.rowsTotal) *
        100
    )
  }
  return batch.status === "importing" || batch.status === "parsing" ? 0 : 100
}
