import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm"
import { getDb } from "@/lib/db"
import { categories, transactions } from "@/lib/db/schema"
import {
  LABEL_STATUSES,
  TX_STATUSES,
  type LabelStatus,
  type TxStatus,
} from "@/lib/db/status"

export interface TransactionFilters {
  q?: string
  dateFrom?: string
  dateTo?: string
  type?: "Ausgang" | "Eingang"
  categoryIds?: number[]
  accountId?: number
  labelStatus?: LabelStatus
  /** default 'Gebucht'; 'all' disables the filter */
  status?: TxStatus | "all"
  sort?: "booking_date" | "amount_cents" | "payee"
  dir?: "asc" | "desc"
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function parseFilters(sp: URLSearchParams): TransactionFilters {
  const q = sp.get("q")?.trim() || undefined
  // reject malformed dates instead of feeding garbage into lexical SQL
  // comparisons (silently wrong/empty results)
  const rawFrom = sp.get("dateFrom")
  const rawTo = sp.get("dateTo")
  const dateFrom = rawFrom && ISO_DATE.test(rawFrom) ? rawFrom : undefined
  const dateTo = rawTo && ISO_DATE.test(rawTo) ? rawTo : undefined
  const typeRaw = sp.get("type")
  const type =
    typeRaw === "Ausgang" || typeRaw === "Eingang" ? typeRaw : undefined
  const categoryIds = sp
    .getAll("categoryId")
    .map((v) => Number.parseInt(v, 10))
    .filter((v) => Number.isInteger(v) && v > 0)
  const accountIdRaw = sp.get("accountId")
  const accountId =
    accountIdRaw && Number.isInteger(Number.parseInt(accountIdRaw, 10))
      ? Number.parseInt(accountIdRaw, 10)
      : undefined
  const labelStatusRaw = sp.get("labelStatus")
  const labelStatus = LABEL_STATUSES.includes(labelStatusRaw as LabelStatus)
    ? (labelStatusRaw as LabelStatus)
    : undefined
  const statusRaw = sp.get("status")
  const status: TxStatus | "all" =
    statusRaw === "all"
      ? "all"
      : TX_STATUSES.includes(statusRaw as TxStatus)
        ? (statusRaw as TxStatus)
        : "Gebucht"
  const sortRaw = sp.get("sort")
  const sort =
    sortRaw === "amount_cents" || sortRaw === "payee" ? sortRaw : "booking_date"
  const dir = sp.get("dir") === "asc" ? "asc" : "desc"
  return {
    q,
    dateFrom,
    dateTo,
    type,
    categoryIds,
    accountId,
    labelStatus,
    status,
    sort,
    dir,
  }
}

/** escape LIKE wildcards in user input; match with LIKE ... ESCAPE '\' */
function escapeLike(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1")
}

export function buildWhere(f: TransactionFilters): SQL | undefined {
  const conditions: SQL[] = []
  if (f.status !== "all") {
    conditions.push(eq(transactions.status, f.status ?? "Gebucht"))
  }
  if (f.q) {
    const escaped = `%${escapeLike(f.q)}%`
    // drizzle's like() emits no ESCAPE clause, so the backslashes from
    // escapeLike would be literals — emit the ESCAPE clause explicitly
    // or searches containing % _ \ match nothing
    const cond = or(
      sql`${transactions.payee} LIKE ${escaped} ESCAPE '\\'`,
      sql`${transactions.payer} LIKE ${escaped} ESCAPE '\\'`,
      sql`${transactions.purpose} LIKE ${escaped} ESCAPE '\\'`
    )
    if (cond) conditions.push(cond)
  }
  if (f.dateFrom) conditions.push(gte(transactions.bookingDate, f.dateFrom))
  if (f.dateTo) conditions.push(lte(transactions.bookingDate, f.dateTo))
  if (f.type) conditions.push(eq(transactions.type, f.type))
  if (f.categoryIds && f.categoryIds.length > 0) {
    conditions.push(inArray(transactions.categoryId, f.categoryIds))
  }
  if (f.accountId !== undefined) {
    conditions.push(eq(transactions.accountId, f.accountId))
  }
  if (f.labelStatus) {
    conditions.push(eq(transactions.labelStatus, f.labelStatus))
  }
  return conditions.length > 0 ? and(...conditions) : undefined
}

export function buildOrderBy(f: TransactionFilters) {
  const dir = f.dir === "asc" ? asc : desc
  switch (f.sort) {
    case "amount_cents":
      return [dir(transactions.amountCents), desc(transactions.bookingDate)]
    case "payee":
      return [dir(transactions.payee), desc(transactions.bookingDate)]
    default:
      return [dir(transactions.bookingDate), desc(transactions.amountCents)]
  }
}

export interface TransactionPage {
  rows: Array<{
    id: string
    bookingDate: string
    valueDate: string | null
    status: string
    payer: string | null
    payee: string | null
    purpose: string | null
    type: string
    counterpartyIban: string | null
    amountCents: number
    categoryId: number | null
    categoryName: string | null
    labelStatus: string
  }>
  total: number
  page: number
  pageCount: number
}

export function queryTransactions(
  f: TransactionFilters,
  page: number,
  pageSize: number
): TransactionPage {
  const db = getDb()
  const where = buildWhere(f)

  const total =
    db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(where)
      .get()?.count ?? 0

  const rows = db
    .select({
      id: transactions.id,
      bookingDate: transactions.bookingDate,
      valueDate: transactions.valueDate,
      status: transactions.status,
      payer: transactions.payer,
      payee: transactions.payee,
      purpose: transactions.purpose,
      type: transactions.type,
      counterpartyIban: transactions.counterpartyIban,
      amountCents: transactions.amountCents,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      labelStatus: transactions.labelStatus,
    })
    .from(transactions)
    .leftJoin(categories, eq(transactions.categoryId, categories.id))
    .where(where)
    .orderBy(...buildOrderBy(f))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()

  return {
    rows,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  }
}
