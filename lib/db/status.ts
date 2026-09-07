/**
 * Single source of truth for the string-encoded state machines stored in
 * SQLite text columns. A typo in any of these literals would otherwise
 * silently create a new state; typed unions + $type<>() on the drizzle
 * columns make that a compile error.
 */

/** import_batches.status */
export const IMPORT_STAGES = [
  "parsing",
  "importing",
  "labeling",
  "completed",
  "failed",
] as const
export type ImportStage = (typeof IMPORT_STAGES)[number]

/** Non-terminal import stages; 'labeling' is resumed by the worker. */
export const STUCK_STAGES: readonly ImportStage[] = ["parsing", "importing"]

/** transactions.status — DKB export values */
export const TX_STATUSES = ["Gebucht", "Nicht gebucht"] as const
export type TxStatus = (typeof TX_STATUSES)[number]

export const BOOKED: TxStatus = "Gebucht"
export const PENDING: TxStatus = "Nicht gebucht"

/** transactions.label_status */
export const LABEL_STATUSES = ["pending", "labeled", "failed"] as const
export type LabelStatus = (typeof LABEL_STATUSES)[number]

/** categories.origin */
export const CATEGORY_ORIGINS = ["manual", "llm"] as const
export type CategoryOrigin = (typeof CATEGORY_ORIGINS)[number]
