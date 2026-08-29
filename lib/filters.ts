export interface DashboardFilters {
  q: string
  dateFrom: string | null
  dateTo: string | null
  type: "Ausgang" | "Eingang" | "all"
  categoryIds: number[]
}

export const EMPTY_FILTERS: DashboardFilters = {
  q: "",
  dateFrom: null,
  dateTo: null,
  type: "all",
  categoryIds: [],
}

export function filtersToParams(f: DashboardFilters): URLSearchParams {
  const sp = new URLSearchParams()
  if (f.q) sp.set("q", f.q)
  if (f.dateFrom) sp.set("dateFrom", f.dateFrom)
  if (f.dateTo) sp.set("dateTo", f.dateTo)
  if (f.type !== "all") sp.set("type", f.type)
  for (const id of f.categoryIds) sp.append("categoryId", String(id))
  return sp
}
