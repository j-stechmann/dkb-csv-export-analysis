/**
 * Shared API contract for the frontend: canonical response types (single
 * source — the backend modules), a queryKeys factory (no more ad-hoc key
 * arrays with colliding shapes), and a fetch helper that throws on
 * !res.ok so errors surface as react-query errors instead of being cast
 * into fake data.
 */
import type { AnalyticsResult } from "@/lib/analytics/engine"
import type { TransactionPage } from "@/lib/analytics/queries"
import type { ImportStage, LabelStatus, TxStatus } from "@/lib/db/status"

export type { AnalyticsResult, TransactionPage }
export type { ImportStage, LabelStatus, TxStatus }

// ── canonical response types (mirrors of route handler outputs) ──────

export interface ImportBatchState {
  id: string
  fileName: string
  status: ImportStage
  error: string | null
  rowsTotal: number
  rowsImported: number
  rowsDuplicate: number
  rowsUpdated: number
  labelsTotal: number
  labelsDone: number
  labelsFailed: number
  createdAt: string
}

export interface StartImportResponse {
  batchId: string
  account: { name: string; iban: string }
  snapshotDate: string | null
  snapshotAmountCents: number | null
}

export interface Label {
  id: number
  name: string
  origin: "manual" | "llm"
  usageCount: number
  ruleCount: number
}

export interface LabelRule {
  id: number
  labelId: number
  iban: string
  nameKey: string
  name: string
}

export interface CategoryOption {
  id: number
  name: string
  origin: "manual" | "llm"
  usageCount: number
  count: number
}

export interface ApiError {
  error: string
  message?: string
}

// ── query keys ────────────────────────────────────────────────────────

/**
 * Central query-key factory. Key shapes are namespaced so a prefix
 * invalidate can never mean two different things (the old
 * ["label-rules", id] collision between label-id and rule-id spaces).
 */
export const qk = {
  labels: ["labels"] as const,
  labelRules: (labelId: number) => ["label-rules", "label", labelId] as const,
  ruleMatches: (ruleId: number) =>
    ["label-rules", "rule", ruleId, "matches"] as const,
  transactions: (params?: unknown) => ["transactions", params] as const,
  analytics: (params?: unknown) => ["analytics", params] as const,
  imports: ["imports"] as const,
  import: (batchId: string) => ["import", batchId] as const,
  categories: ["categories"] as const,
  llmHealth: ["llm-health"] as const,
}

// ── fetch helper ──────────────────────────────────────────────────────

/** Error with the parsed API error envelope attached. */
export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "ApiRequestError"
  }
}

/**
 * fetch + res.ok check + JSON parse. Non-2xx throws ApiRequestError with
 * the server's {error, message} envelope — never returns fake data.
 */
export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    let code = "http_error"
    let message = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as ApiError
      if (body?.error) code = body.error
      if (body?.message) message = body.message
    } catch {
      // non-JSON error body: keep the HTTP fallbacks
    }
    throw new ApiRequestError(res.status, code, message)
  }
  return (await res.json()) as T
}

/** Human-readable message for UI toasts (German UI copy). */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message
  if (err instanceof Error) return err.message
  return "Netzwerkfehler"
}
