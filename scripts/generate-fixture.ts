/**
 * Generates a deterministic synthetic DKB-style CSV fixture plus a
 * pre-computed KPI manifest. Used by the integration test to verify
 * analytics to the cent.
 *
 * Run: bun scripts/generate-fixture.ts [outdir]
 * Outputs: fixture.csv, fixture-manifest.json
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const HEADER =
  "Buchungsdatum;Wertstellung;Status;Zahlungspflichtige*r;Zahlungsempfänger*in;Verwendungszweck;Umsatztyp;IBAN;Betrag (€);Gläubiger-ID;Mandatsreferenz;Kundenreferenz"

function de(cents: number): string {
  const neg = cents < 0
  const abs = Math.abs(cents)
  const int = Math.floor(abs / 100)
  const frac = String(abs % 100).padStart(2, "0")
  const intStr = int.toLocaleString("de-DE")
  return `${neg ? "-" : ""}${intStr},${frac}`
}

function isoToDkb(iso: string): string {
  const [y, m, d] = iso.split("-")
  return `${d}.${m}.${y.slice(2)}`
}

interface RowSpec {
  date: string
  counterparty: string
  purpose: string
  type: "Ausgang" | "Eingang"
  amountCents: number
  status?: string
}

function row(r: RowSpec): string {
  const status = r.status ?? "Gebucht"
  const payer = r.type === "Eingang" ? r.counterparty : "Ich Selbst"
  const payee = r.type === "Ausgang" ? r.counterparty : "Ich Selbst"
  // quote fields containing delimiters, quotes or newlines (RFC 4180)
  const needsQuote = /[;"\n\r]/.test(r.purpose)
  const purpose = needsQuote ? `"${r.purpose.replace(/"/g, '""')}"` : r.purpose
  return [
    isoToDkb(r.date),
    isoToDkb(r.date),
    status,
    payer,
    payee,
    purpose,
    r.type,
    "DE02100100123456789001",
    de(r.amountCents),
    "",
    "",
    "",
  ].join(";")
}

// ── deterministic 24-month dataset: 2024-01 .. 2025-12 ────────────────
const rows: RowSpec[] = []
const months: string[] = []
for (let y = 2024; y <= 2025; y++) {
  for (let m = 1; m <= 12; m++) {
    months.push(`${y}-${String(m).padStart(2, "0")}`)
  }
}

const SNAP_DATE = "2024-01-05"
const SNAP_CENTS = 5_000_00 // 5.000,00 €

let seed = 42
function rand(max: number): number {
  // deterministic LCG (reserved for future randomized fixtures)
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed % max
}
void rand

for (const month of months) {
  const y = Number.parseInt(month.slice(0, 4))
  const m = Number.parseInt(month.slice(5, 7))
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const day = (d: number) => `${month}-${String(d).padStart(2, "0")}`

  // salary on the 1st (exact)
  rows.push({
    date: day(1),
    counterparty: "Arbeitgeber GmbH",
    purpose: "Gehalt",
    type: "Eingang",
    amountCents: 3_500_00,
  })

  // rent on the 3rd (exact)
  rows.push({
    date: day(3),
    counterparty: "Vermieter GmbH",
    purpose: "Miete",
    type: "Ausgang",
    amountCents: -1_200_00,
  })

  // groceries: 4 varying purchases
  for (let i = 0; i < 4; i++) {
    const cents = -(2_000 + ((i * 7919 + m * 104729 + y) % 6_000))
    rows.push({
      date: day(5 + i * 5),
      counterparty: "Supermarkt",
      purpose: "Einkauf",
      type: "Ausgang",
      amountCents: cents,
    })
  }

  // identical same-day coffee pair (occurrence dedupe must keep both)
  rows.push({
    date: day(10),
    counterparty: "Cafe Mittelmeer",
    purpose: "Kaffee",
    type: "Ausgang",
    amountCents: -350,
  })
  rows.push({
    date: day(10),
    counterparty: "Cafe Mittelmeer",
    purpose: "Kaffee",
    type: "Ausgang",
    amountCents: -350,
  })

  // subscription with multi-line purpose (quoted CSV field)
  rows.push({
    date: day(15),
    counterparty: "Streaming AG",
    purpose: "SVWZ+Streaming\nAbonnement 01/2024",
    type: "Ausgang",
    amountCents: -1_299,
  })

  // one pending row per month (excluded from booked aggregates by default)
  rows.push({
    date: day(28),
    counterparty: "Pending Shop",
    purpose: "Noch nicht gebucht",
    type: "Ausgang",
    amountCents: -99,
    status: "Nicht gebucht",
  })

  // one zero-amount Eingang (must not distort averages)
  if (m % 3 === 0) {
    rows.push({
      date: day(20),
      counterparty: "Kreditkarte",
      purpose: "Saldoausgleich",
      type: "Eingang",
      amountCents: 0,
    })
  }
}

// one >512-char purpose in the last month (labeller truncation)
rows.push({
  date: "2025-12-20",
  counterparty: "Langtext GmbH",
  purpose: "X".repeat(600),
  type: "Ausgang",
  amountCents: -99_99,
})

// ── CSV assembly (with preamble like real DKB exports) ────────────────
const csvLines = [
  "Girokonto;DE02120300000000202051;",
  "Zeitraum:;01.01.2024 – 31.12.2025;",
  `Kontostand vom 05.01.2024:;${de(SNAP_CENTS)}\u00A0€;`,
  "",
  HEADER,
  ...rows.map(row),
]
const csv = "\uFEFF" + csvLines.join("\n") + "\n"

// ── manifest: hand-derived expectations, computed from the spec above ─
const booked = rows.filter((r) => (r.status ?? "Gebucht") === "Gebucht")

const monthly = months.map((month) => {
  const inMonth = booked.filter((r) => r.date.startsWith(month))
  const income = inMonth
    .filter((r) => r.amountCents > 0)
    .reduce((a, r) => a + r.amountCents, 0)
  const expenses = inMonth
    .filter((r) => r.amountCents < 0)
    .reduce((a, r) => a + -r.amountCents, 0)
  return { month, incomeCents: income, expensesCents: expenses }
})

const totalIncome = monthly.reduce((a, m) => a + m.incomeCents, 0)
const totalExpenses = monthly.reduce((a, m) => a + m.expensesCents, 0)
const monthsCounted = months.length // fixture data ends before "today" (2026)
const avgIncome = Math.round(totalIncome / monthsCounted)
const avgExpenses = Math.round(totalExpenses / monthsCounted)
const savingsRate = (avgIncome - avgExpenses) / avgIncome

// balance: latest snapshot = the only snapshot (2024-01-05, 5000 €)
const sumAfterSnapshot = booked
  .filter((r) => r.date > SNAP_DATE)
  .reduce((a, r) => a + r.amountCents, 0)
const currentBalance = SNAP_CENTS + sumAfterSnapshot

// top categories (expenses by counterparty label the labeller would give;
// the fixture manifest keys on counterparty since labeling is mocked)
const byCounterparty = new Map<string, number>()
for (const r of booked) {
  if (r.amountCents < 0) {
    byCounterparty.set(
      r.counterparty,
      (byCounterparty.get(r.counterparty) ?? 0) + -r.amountCents
    )
  }
}
const topCategories = [...byCounterparty.entries()]
  .map(([name, totalCents]) => ({ name, totalCents }))
  .sort((a, b) => b.totalCents - a.totalCents)

const manifest = {
  csvFileName: "fixture.csv",
  account: { iban: "DE02120300000000202051", name: "Girokonto" },
  snapshot: { date: SNAP_DATE, amountCents: SNAP_CENTS },
  rowCount: rows.length,
  pendingCount: rows.filter((r) => r.status === "Nicht gebucht").length,
  zeroAmountCount: rows.filter((r) => r.amountCents === 0).length,
  expected: {
    // analytics only over Status='Gebucht'
    transactionCount: booked.length,
    currentBalanceCents: currentBalance,
    avgMonthlyIncomeCents: avgIncome,
    avgMonthlyExpensesCents: avgExpenses,
    savingsRate,
    monthsCounted,
    monthlyCashflow: monthly,
    topCategories,
  },
}

const outDir = process.argv[2] ?? "tests/fixtures"
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, "fixture.csv"), csv, "utf8")
writeFileSync(
  join(outDir, "fixture-manifest.json"),
  JSON.stringify(manifest, null, 2),
  "utf8"
)
console.log(
  `wrote ${outDir}/fixture.csv (${rows.length} rows) and fixture-manifest.json`
)
