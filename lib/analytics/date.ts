/**
 * Local calendar date (YYYY-MM-DD). Not UTC-based: `toISOString()` shifts
 * the date for timezones east of UTC before noon / west after noon, which
 * would name the wrong "current month" around month boundaries.
 */
export function todayLocal(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}