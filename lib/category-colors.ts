export const CATEGORY_PALETTE = [
  "oklch(0.62 0.17 250)",
  "oklch(0.7 0.13 210)",
  "oklch(0.66 0.13 175)",
  "oklch(0.65 0.17 150)",
  "oklch(0.68 0.16 125)",
  "oklch(0.7 0.15 95)",
  "oklch(0.66 0.18 60)",
  "oklch(0.63 0.19 25)",
  "oklch(0.63 0.2 0)",
  "oklch(0.62 0.21 330)",
  "oklch(0.6 0.19 295)",
  "oklch(0.58 0.18 270)",
]

export const UNLABELED_COLOR = "oklch(0.556 0 0)"

const GOLDEN = 0.618033988749895

type Oklch = { l: number; c: number; h: number }

/** Parse "oklch(L C H)" strings (the format this module produces). */
function parseOklch(color: string): Oklch | null {
  const match = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(color)
  if (!match) return null
  return {
    l: Number(match[1]),
    c: Number(match[2]),
    h: Number(match[3]),
  }
}

/** Shortest distance between two hues on the 0–360 circle. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** Distance combining circular hue (degrees) and lightness (scaled to match). */
function colorDistance(a: Oklch, b: Oklch): number {
  return Math.hypot(hueDistance(a.h, b.h), (a.l - b.l) * 180)
}

const WALK_WINDOW = 200
const WALK_LIMIT = 10_000

/**
 * Pick a display color for a new category: the first curated palette entry
 * not yet in use; beyond the palette, the golden-angle hue walk candidate
 * farthest from every used color (never gray, hard string-uniqueness).
 * `used` = colors already assigned.
 */
export function pickCategoryColor(used: string[]): string {
  const taken = new Set(used)

  for (const palette of CATEGORY_PALETTE) {
    if (!taken.has(palette)) return palette
  }

  // Procedural fallback: candidate j walks the hue circle via the golden
  // angle, with lightness/chroma from a second sequence. The palette spans
  // every hue at similar lightness, so no candidate is strictly free of
  // close neighbors once all 12 entries are used — instead of a closeness
  // veto, the untaken candidate with the largest gap to the nearest used
  // color wins (farthest-point sampling).
  const parsed = used
    .map(parseOklch)
    .filter((c): c is Oklch => c !== null && c.c >= 0.05)
  const candidateAt = (j: number): Oklch => ({
    l: 0.6 + 0.1 * ((j * GOLDEN * 7) % 1),
    c: 0.14 + 0.06 * ((j * GOLDEN * 13) % 1),
    h: (j * GOLDEN * 360) % 360,
  })
  let best: string | null = null
  let bestDistance = -1
  for (let j = 1; j <= WALK_WINDOW; j++) {
    const candidate = candidateAt(j)
    const key = formatOklch(candidate)
    if (taken.has(key)) continue
    const nearest = Math.min(...parsed.map((p) => colorDistance(candidate, p)))
    if (nearest > bestDistance) {
      bestDistance = nearest
      best = key
    }
  }
  if (best) return best
  // Walk window exhausted (hundreds of categories): continue the walk
  // deterministically, keeping only hard string-uniqueness.
  for (let j = WALK_WINDOW + 1; j <= WALK_LIMIT; j++) {
    const key = formatOklch(candidateAt(j))
    if (!taken.has(key)) return key
  }
  throw new Error("category color space exhausted")
}

function formatOklch({ l, c, h }: Oklch): string {
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h.toFixed(1)})`
}

export function getCategoryColor(categoryId: number | null): string {
  if (categoryId === null) return UNLABELED_COLOR
  const golden = (categoryId * GOLDEN) % 1
  return CATEGORY_PALETTE[Math.floor(golden * CATEGORY_PALETTE.length)]
}

/** Stored color wins (permanent); hash falls back for legacy NULL rows. */
export function resolveCategoryColor(
  categoryId: number | null,
  stored: string | null | undefined
): string {
  return stored ?? getCategoryColor(categoryId)
}
