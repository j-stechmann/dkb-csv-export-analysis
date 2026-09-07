"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  apiFetch,
  apiErrorMessage,
  qk,
  type StartImportResponse,
} from "@/lib/api/client"
import {
  invalidateAfterLabelChange,
  invalidateAfterRuleChange,
} from "@/hooks/use-invalidate"

/**
 * Shared write hooks: every mutation uses useMutation (consistent
 * pending/error semantics), the canonical invalidation sets, and one
 * German toast-on-error path.
 */

function useToastMutation<TData, TVars>(
  options: Parameters<typeof useMutation<TData, Error, TVars, unknown>>[0] & {
    successMessage?: (data: TData) => string
  }
) {
  return useMutation<TData, Error, TVars, unknown>({
    ...options,
    onError: (err, vars, onMutateResult, ctx) => {
      toast.error(apiErrorMessage(err))
      options.onError?.(err, vars, onMutateResult, ctx)
    },
  })
}

export function useCreateLabel() {
  const queryClient = useQueryClient()
  return useToastMutation<{ id: number; name: string }, { name: string }>({
    mutationFn: (vars) =>
      apiFetch("/api/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      }),
    onSuccess: (data) => {
      invalidateAfterLabelChange(queryClient)
      toast.success(`Label "${data.name}" erstellt`)
    },
  })
}

export function useRenameLabel() {
  const queryClient = useQueryClient()
  return useToastMutation<
    { id: number; name: string },
    { id: number; name: string }
  >({
    mutationFn: (vars) =>
      apiFetch(`/api/labels/${vars.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: vars.name }),
      }),
    onSuccess: (data) => {
      invalidateAfterLabelChange(queryClient)
      toast.success(`Label umbenannt zu "${data.name}"`)
    },
  })
}

export function useDeleteLabel() {
  const queryClient = useQueryClient()
  return useToastMutation<{ affected: number }, number>({
    mutationFn: (id) => apiFetch(`/api/labels/${id}`, { method: "DELETE" }),
    onSuccess: (data) => {
      invalidateAfterLabelChange(queryClient)
      toast.success(
        `Label gelöscht (${data.affected} Transaktionen zurückgesetzt)`
      )
    },
  })
}

export function useEditRule() {
  const queryClient = useQueryClient()
  return useToastMutation<
    { rule: { id: number } },
    { id: number; labelId: number; iban: string; name: string }
  >({
    mutationFn: (vars) =>
      apiFetch(`/api/label-rules/${vars.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          labelId: vars.labelId,
          iban: vars.iban,
          name: vars.name,
        }),
      }),
    onSuccess: () => {
      invalidateAfterRuleChange(queryClient)
      toast.success("Regel gespeichert")
    },
  })
}

export function useApplyRule() {
  const queryClient = useQueryClient()
  return useToastMutation<{ applied: number }, number>({
    mutationFn: (ruleId) =>
      apiFetch(`/api/label-rules/${ruleId}/apply`, { method: "POST" }),
    onSuccess: (data) => {
      invalidateAfterRuleChange(queryClient)
      toast.success(
        `Regel angewendet (${data.applied} Transaktionen neu eingeordnet)`
      )
    },
  })
}

export function useDeleteRule() {
  const queryClient = useQueryClient()
  return useToastMutation<{ deleted: number }, number>({
    mutationFn: (ruleId) =>
      apiFetch(`/api/label-rules/${ruleId}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateAfterRuleChange(queryClient)
      toast.success("Regel gelöscht")
    },
  })
}

export function useAssignLabel() {
  const queryClient = useQueryClient()
  return useToastMutation<
    { id: string; labelId: number },
    { txId: string; labelId?: number; labelName?: string }
  >({
    mutationFn: (vars) =>
      apiFetch(`/api/transactions/${vars.txId}/label`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          vars.labelId !== undefined
            ? { labelId: vars.labelId }
            : { labelName: vars.labelName }
        ),
      }),
    onSuccess: () => {
      // assigning a label also LEARNS a rule server-side → the full set
      invalidateAfterLabelChange(queryClient)
    },
  })
}

export function useRetryLabeling() {
  const queryClient = useQueryClient()
  return useToastMutation<{ queued: number }, void>({
    mutationFn: () => apiFetch("/api/labels/retry", { method: "POST" }),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: qk.imports })
      void queryClient.invalidateQueries({ queryKey: qk.transactions() })
      void queryClient.invalidateQueries({ queryKey: qk.analytics() })
      void queryClient.invalidateQueries({ queryKey: qk.categories })
      toast.success(`${data.queued} Transaktionen neu in die Warteschlange`)
    },
  })
}

export function useStartImport() {
  const queryClient = useQueryClient()
  return useToastMutation<StartImportResponse, { file: File }>({
    mutationFn: (vars) => {
      const form = new FormData()
      form.set("file", vars.file)
      return apiFetch("/api/imports", { method: "POST", body: form })
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: qk.imports })
      toast.success("Import gestartet", {
        description: `Konto ${data.account.name} (${data.account.iban})`,
      })
    },
  })
}
