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

function isTooClose(candidate: Oklch, existing: Oklch): boolean {
  return (
    hueDistance(candidate.h, existing.h) < 20 &&
    Math.abs(candidate.l - existing.l) < 0.1
  )
}

/**
 * Pick a display color for a new category: the first curated palette entry
 * not yet in use; beyond the palette, procedurally generate unique colors
 * (golden-ratio hue walk, never gray). `used` = colors already assigned.
 */
export function pickCategoryColor(used: string[]): string {
  const taken = new Set(used)
  const parsed = used
    .map(parseOklch)
    .filter((c): c is Oklch => c !== null && c.c >= 0.05)

  for (const palette of CATEGORY_PALETTE) {
    if (palette !== UNLABELED_COLOR && !taken.has(palette)) return palette
  }

  // Procedural fallback: candidate j walks the hue circle via the golden
  // angle (maximally spread), with lightness/chroma from a second sequence.
  let fallback: Oklch | null = null
  for (let j = 1; j <= 100; j++) {
    const candidate: Oklch = {
      l: 0.6 + 0.1 * ((j * GOLDEN * 7) % 1),
      c: 0.14 + 0.06 * ((j * GOLDEN * 13) % 1),
      h: (j * GOLDEN * 360) % 360,
    }
    const key = formatOklch(candidate)
    if (taken.has(key)) continue
    if (!parsed.some((p) => isTooClose(candidate, p))) return key
    fallback ??= candidate
  }
  if (fallback) return formatOklch(fallback)
  // Exhausted (absurdly many near-identical hues): relax the closeness rule,
  // keep only hard string-uniqueness.
  for (let j = 101; j <= 1000; j++) {
    const key = formatOklch({
      l: 0.6 + 0.1 * ((j * GOLDEN * 7) % 1),
      c: 0.14 + 0.06 * ((j * GOLDEN * 13) % 1),
      h: (j * GOLDEN * 360) % 360,
    })
    if (!taken.has(key)) return key
  }
  return formatOklch({
    l: 0.6,
    c: 0.14,
    h: (Date.now() % 1000) * 0.36,
  })
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
