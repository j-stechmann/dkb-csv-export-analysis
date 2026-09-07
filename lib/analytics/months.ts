/**
 * Calendar-month helpers over "YYYY-MM" / ISO date strings — pure string
 * arithmetic, no Date objects (no timezone pitfalls). Shared by the
 * analytics engine, the fixture generator and their tests.
 */

/** "YYYY-MM" of an ISO date. */
export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7)
}

/** Previous calendar month of "YYYY-MM". */
export function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number)
  const ny = m === 1 ? y - 1 : y
  const nm = m === 1 ? 12 : m - 1
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`
}

/** Next calendar month of "YYYY-MM". */
export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number)
  const ny = m === 12 ? y + 1 : y
  const nm = m === 12 ? 1 : m + 1
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}`
}

/** All "YYYY-MM" values between two ISO dates, inclusive. */
export function monthsBetween(fromIso: string, toIso: string): string[] {
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

/** Day-of-month ("01".."31") of the last calendar day containing iso. */
export function lastDayOfMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number)
  return String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")
}
