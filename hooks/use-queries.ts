"use client"

import { useQuery } from "@tanstack/react-query"
import {
  apiFetch,
  qk,
  type AnalyticsResult,
  type CategoryOption,
  type ImportBatchState,
  type Label,
  type LabelRule,
  type TransactionPage,
} from "@/lib/api/client"
import type { LlmHealth } from "@/lib/llm/client"

/** Shared read hooks: one per REST resource, all using apiFetch + qk. */

export function useLabels() {
  return useQuery({
    queryKey: qk.labels,
    queryFn: () => apiFetch<{ labels: Label[] }>("/api/labels"),
    select: (data) => data.labels,
  })
}

export function useLabelRules(labelId: number, enabled = true) {
  return useQuery({
    queryKey: qk.labelRules(labelId),
    enabled,
    queryFn: () =>
      apiFetch<{ rules: LabelRule[] }>(`/api/labels/${labelId}/rules`),
    select: (data) => data.rules,
  })
}

export function useRuleMatches(ruleId: number, enabled = true) {
  return useQuery({
    queryKey: qk.ruleMatches(ruleId),
    enabled,
    queryFn: () =>
      apiFetch<{ count: number }>(`/api/label-rules/${ruleId}/matches`),
    select: (data) => data.count,
  })
}

export function useCategories() {
  return useQuery({
    queryKey: qk.categories,
    queryFn: () =>
      apiFetch<{ categories: CategoryOption[] }>("/api/categories"),
    select: (data) => data.categories,
  })
}

export function useTransactions(params: URLSearchParams) {
  return useQuery({
    queryKey: qk.transactions(params.toString()),
    queryFn: () => apiFetch<TransactionPage>(`/api/transactions?${params}`),
    placeholderData: (prev) => prev,
  })
}

export function useAnalytics(params: URLSearchParams) {
  return useQuery({
    queryKey: qk.analytics(params.toString()),
    queryFn: () => apiFetch<AnalyticsResult>(`/api/analytics?${params}`),
    placeholderData: (prev) => prev,
  })
}

export function useImportHistory() {
  return useQuery({
    queryKey: qk.imports,
    queryFn: () =>
      apiFetch<{ batches: ImportBatchState[] }>("/api/imports/history"),
    select: (data) => data.batches,
  })
}

export function useLlmHealth(enabled = true) {
  return useQuery({
    queryKey: qk.llmHealth,
    enabled,
    queryFn: () => apiFetch<{ status: LlmHealth }>("/api/llm/health"),
    select: (data) => data.status,
    refetchInterval: 30_000,
  })
}
