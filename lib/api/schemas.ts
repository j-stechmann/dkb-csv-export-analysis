import { z } from "zod"
import { LABEL_STATUSES, TX_STATUSES } from "@/lib/db/status"

/**
 * Zod schemas for API inputs — the single validation layer for query
 * params and request bodies. Invalid input → 400 with issues, never a
 * silently-wrong SQL comparison.
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)")

const positiveInt = z.coerce
  .number()
  .int()
  .positive()
  .transform((v) => Math.trunc(v))

export const TransactionsQuerySchema = z.object({
  q: z.string().trim().optional(),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
  type: z.enum(["Ausgang", "Eingang"]).optional(),
  categoryId: z.array(positiveInt).optional(),
  accountId: positiveInt.optional(),
  labelStatus: z.enum(LABEL_STATUSES).optional(),
  status: z
    .enum([...TX_STATUSES, "all"] as const)
    .optional()
    .transform((v) => v ?? "Gebucht"),
  sort: z
    .enum(["booking_date", "amount_cents", "payee"])
    .optional()
    .transform((v) => v ?? "booking_date"),
  dir: z
    .enum(["asc", "desc"])
    .optional()
    .transform((v) => v ?? "desc"),
  page: positiveInt.optional().transform((v) => v ?? 1),
  pageSize: positiveInt.optional().transform((v) => Math.min(v ?? 25, 100)),
})

export type TransactionsQuery = z.infer<typeof TransactionsQuerySchema>

/** Manual label assignment: a label name OR an existing label id. */
export const LabelAssignSchema = z
  .object({
    labelName: z.string().trim().min(1).max(64).optional(),
    labelId: positiveInt.optional(),
  })
  .refine((v) => v.labelName !== undefined || v.labelId !== undefined, {
    message: "labelName oder labelId nötig",
  })

export const LabelCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
})

export const LabelRenameSchema = z.object({
  name: z.string().trim().min(1).max(64),
})

export const RulePatchSchema = z.object({
  labelId: positiveInt,
  iban: z.string().trim().min(1),
  name: z.string().trim().min(1),
})

export const AccountCreateSchema = z.object({
  iban: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase().replace(/\s+/g, ""))
    .pipe(z.string().regex(/^[A-Z]{2}[0-9A-Z]{10,32}$/, "IBAN ist ungültig")),
  name: z.string().trim().min(1).max(100),
})

/** Parse URLSearchParams via a schema; invalid → null (caller returns 400). */
export function parseQuery<T extends z.ZodType>(
  schema: T,
  sp: URLSearchParams
): z.infer<T> | null {
  const raw: Record<string, string | string[]> = {}
  for (const key of new Set(sp.keys())) {
    const all = sp.getAll(key)
    raw[key] = all.length > 1 ? all : all[0]
  }
  const result = schema.safeParse(raw)
  return result.success ? result.data : null
}

/** Read a JSON body via a schema; invalid → null (caller returns 400). */
export async function parseBody<T extends z.ZodType>(
  schema: T,
  request: Request
): Promise<z.infer<T> | null> {
  const body = await request.json().catch(() => null)
  const result = schema.safeParse(body)
  return result.success ? result.data : null
}
