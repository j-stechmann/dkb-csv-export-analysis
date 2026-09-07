"use client"

import type { QueryClient } from "@tanstack/react-query"
import { qk } from "@/lib/api/client"

/**
 * Canonical invalidation sets. Centralized because every write path must
 * invalidate the same queries — the old per-call-site lists drifted (e.g.
 * assigning a label learns a rule server-side but never invalidated
 * label-rules, so the Labels page showed stale rules).
 */

/** Anything that changed labels (create/rename/delete/assign) — also
 *  refreshes learned rules, transactions, analytics and categories. */
export function invalidateAfterLabelChange(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.labels })
  void queryClient.invalidateQueries({ queryKey: ["label-rules"] })
  void queryClient.invalidateQueries({ queryKey: qk.transactions() })
  void queryClient.invalidateQueries({ queryKey: qk.analytics() })
  void queryClient.invalidateQueries({ queryKey: qk.categories })
}

/** Anything that changed learned rules only (edit/apply/delete rule). */
export function invalidateAfterRuleChange(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ["label-rules"] })
  void queryClient.invalidateQueries({ queryKey: qk.labels })
  void queryClient.invalidateQueries({ queryKey: qk.transactions() })
  void queryClient.invalidateQueries({ queryKey: qk.analytics() })
  void queryClient.invalidateQueries({ queryKey: qk.categories })
}

/** A finished import (called by ActiveImportProvider on completion). */
export function invalidateAfterImport(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.imports })
  void queryClient.invalidateQueries({ queryKey: qk.transactions() })
  void queryClient.invalidateQueries({ queryKey: qk.analytics() })
  void queryClient.invalidateQueries({ queryKey: qk.categories })
  void queryClient.invalidateQueries({ queryKey: qk.labels })
  void queryClient.invalidateQueries({ queryKey: ["label-rules"] })
}
