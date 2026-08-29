import type { ParsedTransactionRow } from "@/lib/csv/parser"
import type { Transaction } from "@/lib/db/schema"

export const MATCH_WINDOW_DAYS = 7

const PENDING = "Nicht gebucht"
const BOOKED = "Gebucht"

/**
 * DB-side counterpart of an incoming ParsedTransactionRow: minimal generic
 * shape so pipeline and tests can construct candidates without the DB.
 */
export interface DbMatchRow {
  id: string
  bookingDate: string
  valueDate: string
  status: string
  payer: string | null
  payee: string | null
  purpose: string | null
  type: string
  counterpartyIban: string | null
  amountCents: number
  creditorId: string | null
  mandateRef: string | null
  customerRef: string | null
  sourceHash: string
  occurrenceIndex: number
}

export function toDbMatchRow(t: Transaction): DbMatchRow {
  return {
    id: t.id,
    bookingDate: t.bookingDate,
    valueDate: t.valueDate ?? "",
    status: t.status,
    payer: t.payer,
    payee: t.payee,
    purpose: t.purpose,
    type: t.type,
    counterpartyIban: t.counterpartyIban,
    amountCents: t.amountCents,
    creditorId: t.creditorId,
    mandateRef: t.mandateRef,
    customerRef: t.customerRef,
    sourceHash: t.sourceHash,
    occurrenceIndex: t.occurrenceIndex,
  }
}

/** Absolute day difference between two ISO date strings. */
export function dayDiff(isoA: string, isoB: string): number {
  const a = Date.parse(`${isoA}T00:00:00Z`)
  const b = Date.parse(`${isoB}T00:00:00Z`)
  return Math.abs(Math.round((a - b) / 86_400_000))
}

interface Matchable {
  bookingDate: string
  type: string
  counterpartyIban: string | null
  amountCents: number
  creditorId: string | null
  mandateRef: string | null
}

/**
 * Party identity: equal non-empty counterpartyIban, OR equal non-empty
 * creditorId, OR equal non-empty mandateRef — if none of the three is set
 * on both sides there is no match.
 */
function partyMatches(a: Matchable, b: Matchable): boolean {
  if (a.counterpartyIban && b.counterpartyIban) {
    return a.counterpartyIban === b.counterpartyIban
  }
  if (a.creditorId && b.creditorId) {
    return a.creditorId === b.creditorId
  }
  if (a.mandateRef && b.mandateRef) {
    return a.mandateRef === b.mandateRef
  }
  return false
}

function viableMatch(a: Matchable, b: Matchable): boolean {
  if (a.type !== b.type) return false
  if (a.amountCents !== b.amountCents) return false
  if (!partyMatches(a, b)) return false
  // NaN (malformed date) must not pass as a candidate
  return dayDiff(a.bookingDate, b.bookingDate) <= MATCH_WINDOW_DAYS
}

function sameContent(db: DbMatchRow, inc: ParsedTransactionRow): boolean {
  return (
    db.bookingDate === inc.bookingDate &&
    db.valueDate === inc.valueDate &&
    db.status === inc.status &&
    (db.payer ?? "") === inc.payer &&
    (db.payee ?? "") === inc.payee &&
    (db.purpose ?? "") === inc.purpose &&
    db.type === inc.type &&
    (db.counterpartyIban ?? "") === inc.counterpartyIban &&
    db.amountCents === inc.amountCents &&
    (db.creditorId ?? "") === inc.creditorId &&
    (db.mandateRef ?? "") === inc.mandateRef &&
    (db.customerRef ?? "") === inc.customerRef
  )
}

/**
 * Greedy 1:1 pairing over candidates: smallest |date diff| first, then
 * kind priority (upgrades before skips before refreshes), then earliest
 * DB bookingDate, then row ids/positions for determinism. Each side is
 * consumed at most once.
 */
function greedyAssign<T extends Candidate>(candidates: T[]): T[] {
  const sorted = [...candidates].sort(
    (a, b) =>
      a.diff - b.diff ||
      a.rank - b.rank ||
      a.dbBookingDate.localeCompare(b.dbBookingDate) ||
      a.leftKey.localeCompare(b.leftKey) ||
      a.rightKey.localeCompare(b.rightKey)
  )
  const usedLeft = new Set<string>()
  const usedRight = new Set<string>()
  const chosen: T[] = []
  for (const c of sorted) {
    if (usedLeft.has(c.leftKey) || usedRight.has(c.rightKey)) continue
    usedLeft.add(c.leftKey)
    usedRight.add(c.rightKey)
    chosen.push(c)
  }
  return chosen
}

interface Candidate {
  kind: "upgrade" | "skip" | "refresh"
  rank: number
  leftKey: string
  rightKey: string
  diff: number
  dbBookingDate: string
}

const KIND_RANK: Record<Candidate["kind"], number> = {
  upgrade: 0,
  skip: 1,
  refresh: 2,
}

function buildCandidate(
  kind: Candidate["kind"],
  db: DbMatchRow,
  inc: ParsedTransactionRow,
  incIndex: number
): Candidate | null {
  if (!viableMatch(db, inc)) return null
  return {
    kind,
    rank: KIND_RANK[kind],
    leftKey: db.id,
    rightKey: String(incIndex),
    diff: dayDiff(db.bookingDate, inc.bookingDate),
    dbBookingDate: db.bookingDate,
  }
}

export interface FuzzyMatch {
  upgrades: Array<{ incomingIndex: number; dbId: string }>
  refreshes: Array<{ incomingIndex: number; dbId: string }>
  skips: Array<{ incomingIndex: number; dbId: string }>
}

/**
 * Classify incoming rows against the DB rows of one account:
 * - upgrade: incoming Gebucht ↔ DB Nicht gebucht (booked version arrived;
 *   DB pending row is updated in place)
 * - skip: incoming Nicht gebucht ↔ DB Gebucht (booked copy already stored;
 *   do not import)
 * - refresh: incoming Nicht gebucht ↔ DB Nicht gebucht with differing
 *   content (DB pending row is refreshed in place)
 * Equal-content pending pairs are deliberately absent: the exact-dedupe
 * tier already counts them as duplicates, so they are not consumed here.
 */
export function matchIncoming(
  dbRows: DbMatchRow[],
  incoming: ParsedTransactionRow[]
): FuzzyMatch {
  const candidates: Candidate[] = []
  for (const db of dbRows) {
    for (let i = 0; i < incoming.length; i++) {
      const inc = incoming[i]
      if (db.status === PENDING) {
        if (inc.status === BOOKED) {
          const c = buildCandidate("upgrade", db, inc, i)
          if (c) candidates.push(c)
        } else if (inc.status === PENDING && !sameContent(db, inc)) {
          const c = buildCandidate("refresh", db, inc, i)
          if (c) candidates.push(c)
        }
      } else if (db.status === BOOKED && inc.status === PENDING) {
        const c = buildCandidate("skip", db, inc, i)
        if (c) candidates.push(c)
      }
    }
  }

  const result: FuzzyMatch = { upgrades: [], refreshes: [], skips: [] }
  for (const c of greedyAssign(candidates)) {
    const entry = { incomingIndex: Number(c.rightKey), dbId: c.leftKey }
    if (c.kind === "upgrade") result.upgrades.push(entry)
    else if (c.kind === "skip") result.skips.push(entry)
    else result.refreshes.push(entry)
  }
  return result
}

/**
 * Self-heal: pending DB rows that fuzzy-match a booked row of the same
 * account are stale leftovers of earlier provisional imports → the pending
 * side becomes a delete candidate (the booked row stays).
 */
export function findDbSelfHealPairs(
  dbRows: DbMatchRow[]
): Array<{ pendingId: string; bookedId: string }> {
  const pending = dbRows.filter((r) => r.status === PENDING)
  const booked = dbRows.filter((r) => r.status === BOOKED)
  const candidates: Candidate[] = []
  for (const p of pending) {
    for (const b of booked) {
      if (!viableMatch(p, b)) continue
      candidates.push({
        kind: "upgrade",
        rank: 0,
        leftKey: p.id,
        rightKey: b.id,
        diff: dayDiff(p.bookingDate, b.bookingDate),
        dbBookingDate: p.bookingDate,
      })
    }
  }
  return greedyAssign(candidates).map((c) => ({
    pendingId: c.leftKey,
    bookedId: c.rightKey,
  }))
}