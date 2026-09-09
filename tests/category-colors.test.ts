import { describe, it, expect } from "vitest"
import {
  pickCategoryColor,
  getCategoryColor,
  resolveCategoryColor,
  CATEGORY_PALETTE,
  UNLABELED_COLOR,
} from "@/lib/category-colors"

describe("pickCategoryColor", () => {
  it("hands out palette colors in order when nothing is used", () => {
    expect(pickCategoryColor([])).toBe(CATEGORY_PALETTE[0])
    expect(pickCategoryColor([CATEGORY_PALETTE[0]])).toBe(CATEGORY_PALETTE[1])
    expect(pickCategoryColor(CATEGORY_PALETTE.slice(0, 5))).toBe(
      CATEGORY_PALETTE[5]
    )
  })

  it("skips used palette colors", () => {
    const used = [CATEGORY_PALETTE[0], CATEGORY_PALETTE[2]]
    expect(pickCategoryColor(used)).toBe(CATEGORY_PALETTE[1])
  })

  it("returns every color unique across a long allocation sequence", () => {
    const used: string[] = []
    for (let i = 0; i < 200; i++) {
      const color = pickCategoryColor(used)
      expect(used).not.toContain(color)
      used.push(color)
    }
  })

  it("never returns the unlabeled gray", () => {
    const used: string[] = []
    for (let i = 0; i < 50; i++) {
      const color = pickCategoryColor(used)
      expect(color).not.toBe(UNLABELED_COLOR)
      used.push(color)
    }
  })

  it("is deterministic for the same used set", () => {
    const used = [CATEGORY_PALETTE[0], CATEGORY_PALETTE[1]]
    expect(pickCategoryColor(used)).toBe(pickCategoryColor(used))
  })
})

describe("getCategoryColor", () => {
  it("returns gray for unlabeled", () => {
    expect(getCategoryColor(null)).toBe(UNLABELED_COLOR)
  })

  it("is stable per id", () => {
    expect(getCategoryColor(7)).toBe(getCategoryColor(7))
  })
})

describe("resolveCategoryColor", () => {
  it("prefers the stored color", () => {
    expect(resolveCategoryColor(3, "oklch(0.5 0.1 100)")).toBe(
      "oklch(0.5 0.1 100)"
    )
  })

  it("falls back to the hash when no color is stored", () => {
    expect(resolveCategoryColor(3, null)).toBe(getCategoryColor(3))
    expect(resolveCategoryColor(3, undefined)).toBe(getCategoryColor(3))
    expect(resolveCategoryColor(null, null)).toBe(UNLABELED_COLOR)
  })
})
