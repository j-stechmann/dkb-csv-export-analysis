import { and, eq, gt, sql, type SQL } from "drizzle-orm"
import { getDb } from "@/lib/db"
import { importBatches, transactions } from "@/lib/db/schema"
import { buildWhere, type TransactionFilters } from "@/lib/analytics/queries"

export interface MonthlyCashflowPoint {
  month: string // YYYY-MM
  incomeCents: number
  expensesCents: number
  netCents: number
}

export interface BalancePoint {
  date: string
  balanceCents: number
}

export interface TopCategoryPoint {
  categoryId: number | null
  name: string // 'Unlabeled' bucket for null categories
  totalCents: number
  share: number
  txCount: number
}

export interface AnalyticsResult {
  kpis: {
    currentBalanceCents: number | null
    /** true when no snapshot exists → balance is Σ(booked) only */
    balanceWithoutSnapshot: boolean
    avgMonthlyIncomeCents: number | null
    avgMonthlyExpensesCents: number | null
    savingsRate: number | null
    transactionCount: number
    monthsCounted: number
  }
  monthlyCashflow: MonthlyCashflowPoint[]
  balanceTimeline: BalancePoint[]
  topCategories: TopCategoryPoint[]
}

interface BalanceAnchor {
  snapshotDate: string
  snapshotAmountCents: number
}

/**
 * Balance anchor = LATEST snapshot across all batches (most recent known
 * absolute balance point). Current balance = snapshot + Σ(booked amounts
 * with booking_date > snapshot_date) — robust to missing older history.
 */
function latestAnchor(accountId?: number): BalanceAnchor | null {
  const db = getDb()
  const rows = db
    .select({
      snapshotDate: importBatches.snapshotDate,
      snapshotAmountCents: importBatches.snapshotAmountCents,
    })
    .from(importBatches)
    .where(
      accountId !== undefined
        ? and(
            eq(importBatches.accountId, accountId),
            sql`${importBatches.snapshotDate} IS NOT NULL AND ${importBatches.snapshotAmountCents} IS NOT NULL`
          )
        : sql`${importBatches.snapshotDate} IS NOT NULL AND ${importBatches.snapshotAmountCents} IS NOT NULL`
    )
    .all()
  const valid = rows.filter(
    (r): r is { snapshotDate: string; snapshotAmountCents: number } =>
      r.snapshotDate !== null && r.snapshotAmountCents !== null
  )
  if (valid.length === 0) return null
  return valid.reduce((latest, r) =>
    r.snapshotDate > latest.snapshotDate ? r : latest
  )
}

function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7)
}

/** list of YYYY-MM between two ISO dates, inclusive, zero-filled */
function monthsBetween(fromIso: string, toIso: string): string[] {
  const months: string[] = []
  let [y, m] = fromIso.split("-").map(Number)
  const [ty, tm] = toIso.split("-").map(Number)
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return months
}

export function computeAnalytics(
  f: TransactionFilters,
  today: string
): AnalyticsResult {
  const db = getDb()
  const base: SQL[] = []
  if (f.status !== "all") {
    base.push(eq(transactions.status, f.status ?? "Gebucht"))
  }
  if (f.q) {
    // q is a table-filter only (applies in queryTransactions); aggregates
    // intentionally operate on the same filtered set — implement via LIKE
    const escaped = `%${f.q.replace(/([\\%_])/g, "\\$1")}%`
    base.push(
      sql`(${transactions.payee} LIKE ${escaped} OR ${transactions.payer} LIKE ${escaped} OR ${transactions.purpose} LIKE ${escaped})`
    )
  }
  if (f.type) base.push(eq(transactions.type, f.type))
  if (f.categoryIds && f.categoryIds.length > 0) {
    base.push(
      sql`${transactions.categoryId} IN (${sql.join(
        f.categoryIds.map((id) => sql`${id}`),
        sql`, `
      )})`
    )
  }
  if (f.accountId !== undefined) {
    base.push(eq(transactions.accountId, f.accountId))
  }

  // ── monthly aggregation over the filtered set ──────────────────────
  const monthlyRows = db
    .select({
      month: sql<string>`substr(${transactions.bookingDate}, 1, 7)`,
      income: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} > 0 THEN ${transactions.amountCents} ELSE 0 END), 0)`,
      expenses: sql<number>`COALESCE(SUM(CASE WHEN ${transactions.amountCents} < 0 THEN -${transactions.amountCents} ELSE 0 END), 0)`,
    })
    .from(transactions)
    .where(and(...base))
    .groupBy(sql`substr(${transactions.bookingDate}, 1, 7)`)
    .all()

  if (monthlyRows.length === 0) {
    return {
      kpis: {
        currentBalanceCents: null,
        balanceWithoutSnapshot: true,
        avgMonthlyIncomeCents: null,
        avgMonthlyExpensesCents: null,
        savingsRate: null,
        transactionCount: 0,
        monthsCounted: 0,
      },
      monthlyCashflow: [],
      balanceTimeline: [],
      topCategories: [],
    }
  }

  // determine span (respect explicit date filters for the span)
  const bounds = db
    .select({
      min: sql<string>`MIN(${transactions.bookingDate})`,
      max: sql<string>`MAX(${transactions.bookingDate})`,
    })
    .from(transactions)
    .where(and(...base))
    .get()
  const minDate = f.dateFrom ?? bounds?.min ?? today
  const maxDateExclusive = f.dateTo ?? bounds?.max ?? today

  // partial current month: include in series, exclude from averages
  const currentMonth = monthOf(today)
  const lastFullMonth =
    monthOf(maxDateExclusive) >= currentMonth
      ? prevMonth(currentMonth)
      : monthOf(maxDateExclusive)

  const spanStartMonth = monthOf(minDate)
  const allMonths = monthsBetween(spanStartMonth, monthOf(maxDateExclusive))

  const byMonth = new Map(monthlyRows.map((r) => [r.month, r]))
  const monthlyCashflow: MonthlyCashflowPoint[] = allMonths.map((m) => {
    const row = byMonth.get(m)
    const income = row?.income ?? 0
    const expenses = row?.expenses ?? 0
    return {
      month: m,
      incomeCents: income,
      expensesCents: expenses,
      netCents: income - expenses,
    }
  })

  // averages over full months only (excludes partial current month)
  const fullMonths = allMonths.filter(
    (m) => m <= lastFullMonth && m >= spanStartMonth
  )
  const monthsCounted = fullMonths.length
  const sumIncome = fullMonths.reduce(
    (acc, m) => acc + (byMonth.get(m)?.income ?? 0),
    0
  )
  const sumExpenses = fullMonths.reduce(
    (acc, m) => acc + (byMonth.get(m)?.expenses ?? 0),
    0
  )
  const avgIncome =
    monthsCounted > 0 ? Math.round(sumIncome / monthsCounted) : null
  const avgExpenses =
    monthsCounted > 0 ? Math.round(sumExpenses / monthsCounted) : null
  const savingsRate =
    avgIncome !== null && avgIncome > 0
      ? (avgIncome - (avgExpenses ?? 0)) / avgIncome
      : null

  // ── balance: latest snapshot anchor + subsequent bookings ─────────
  const anchor = latestAnchor(f.accountId)
  const totalSum =
    db
      .select({
        sum: sql<number>`COALESCE(SUM(${transactions.amountCents}), 0)`,
      })
      .from(transactions)
      .where(and(...base))
      .get()?.sum ?? 0

  let currentBalanceCents: number | null
  let balanceWithoutSnapshot: boolean

  if (anchor) {
    const afterSnapshot =
      db
        .select({
          sum: sql<number>`COALESCE(SUM(${transactions.amountCents}), 0)`,
        })
        .from(transactions)
        .where(and(...base, gt(transactions.bookingDate, anchor.snapshotDate)))
        .get()?.sum ?? 0
    currentBalanceCents = anchor.snapshotAmountCents + afterSnapshot
    balanceWithoutSnapshot = false
  } else {
    currentBalanceCents = totalSum
    balanceWithoutSnapshot = true
  }

  // ── balance timeline: daily sums, back/forward from the anchor ────
  const dailyRows = db
    .select({
      date: transactions.bookingDate,
      sum: sql<number>`SUM(${transactions.amountCents})`,
    })
    .from(transactions)
    .where(and(...base))
    .groupBy(transactions.bookingDate)
    .orderBy(transactions.bookingDate)
    .all()

  const balanceTimeline: BalancePoint[] = []

  if (anchor) {
    // DKB snapshots sit at the END of the export period, so earlier balances
    // are back-calculated: at every booked day d ≤ snapshot the balance is
    // snapshot − Σ(sums of booked days after d, up to and incl. snapshot day).
    const firstAfter = dailyRows.findIndex((r) => r.date > anchor.snapshotDate)
    const lastBeforeIdx = firstAfter === -1 ? dailyRows.length : firstAfter

    let suffix = 0
    const backward: BalancePoint[] = []
    for (let i = lastBeforeIdx - 1; i >= 0; i--) {
      const row = dailyRows[i]
      if (row.date !== anchor.snapshotDate) {
        backward.push({
          date: row.date,
          balanceCents: anchor.snapshotAmountCents - suffix,
        })
      }
      suffix += row.sum
    }
    backward.reverse()

    const anchorPoint: BalancePoint = {
      date: anchor.snapshotDate,
      balanceCents: anchor.snapshotAmountCents,
    }

    let running = anchor.snapshotAmountCents
    const forward: BalancePoint[] = []
    for (
      let i = firstAfter === -1 ? dailyRows.length : firstAfter;
      i < dailyRows.length;
      i++
    ) {
      running += dailyRows[i].sum
      forward.push({ date: dailyRows[i].date, balanceCents: running })
    }

    balanceTimeline.push(...backward, anchorPoint, ...forward)
  } else {
    // no snapshot: cumulative sum from zero (best-effort pseudo balance)
    let running = 0
    for (const row of dailyRows) {
      running += row.sum
      balanceTimeline.push({ date: row.date, balanceCents: running })
    }
  }

  // ── top categories (expenses only) ────────────────────────────────
  const catRows = db
    .select({
      categoryId: transactions.categoryId,
      name: sql<string>`COALESCE(categories.name, '')`,
      total: sql<number>`COALESCE(SUM(-${transactions.amountCents}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(transactions)
    .leftJoin(sql`categories`, sql`${transactions.categoryId} = categories.id`)
    .where(and(...base, sql`${transactions.amountCents} < 0`))
    .groupBy(transactions.categoryId)
    .orderBy(sql`SUM(-${transactions.amountCents}) DESC`)
    .all()

  const totalExpenses = catRows.reduce((acc, r) => acc + r.total, 0)
  const topCategories: TopCategoryPoint[] = catRows
    .map((r) => ({
      categoryId: r.categoryId,
      name: r.categoryId === null ? "Unlabeled" : r.name,
      totalCents: r.total,
      share: totalExpenses > 0 ? r.total / totalExpenses : 0,
      txCount: r.count,
    }))
    .slice(0, 12)

  const txCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(transactions)
      .where(and(...base))
      .get()?.count ?? 0

  return {
    kpis: {
      currentBalanceCents,
      balanceWithoutSnapshot,
      avgMonthlyIncomeCents: avgIncome,
      avgMonthlyExpensesCents: avgExpenses,
      savingsRate,
      transactionCount: txCount,
      monthsCounted,
    },
    monthlyCashflow,
    balanceTimeline,
    topCategories,
  }
}

function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number)
  const ny = m === 1 ? y - 1 : y
  const nm = m === 1 ? 12 : m - 1
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`
}
