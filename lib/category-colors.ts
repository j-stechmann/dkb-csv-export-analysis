const CATEGORY_PALETTE = [
  "oklch(0.62 0.17 250)",
  "oklch(0.6 0.13 210)",
  "oklch(0.66 0.13 175)",
  "oklch(0.65 0.17 150)",
  "oklch(0.68 0.16 125)",
  "oklch(0.6 0.15 95)",
  "oklch(0.66 0.18 60)",
  "oklch(0.63 0.19 25)",
  "oklch(0.63 0.2 0)",
  "oklch(0.62 0.21 330)",
  "oklch(0.6 0.19 295)",
  "oklch(0.58 0.18 270)",
]

const UNLABELED_COLOR = "oklch(0.556 0 0)"

export function getCategoryColor(categoryId: number | null): string {
  if (categoryId === null) return UNLABELED_COLOR
  const golden = (categoryId * 0.618033988749895) % 1
  return CATEGORY_PALETTE[Math.floor(golden * CATEGORY_PALETTE.length)]
}
