"use client"

import * as React from "react"

export interface ZoomRange {
  start: number
  end: number
}

interface UseChartZoomOpts {
  length: number
  /** changes when the underlying dataset changed → zoom range resets */
  resetKey: string
  /** minimum number of visible points when zooming in */
  minWindow?: number
}

/**
 * Zoom/pan state for time-series charts:
 * - touch: pinch to zoom, drag to pan
 * - mouse: drag to pan, wheel to pan, ctrl+wheel (or trackpad pinch) to zoom
 * Wheel is registered non-passively on the wrapper so preventDefault works.
 */
export function useChartZoom({
  length,
  resetKey,
  minWindow = 5,
}: UseChartZoomOpts) {
  const [range, setRange] = React.useState<ZoomRange | null>(null)
  const [wrapEl, setWrapEl] = React.useState<HTMLDivElement | null>(null)

  // new dataset → the old index window is meaningless, start unzoomed
  const [lastResetKey, setLastResetKey] = React.useState(resetKey)
  if (lastResetKey !== resetKey) {
    setLastResetKey(resetKey)
    setRange(null)
  }

  const pointers = React.useRef(new Map<number, { x: number; y: number }>())
  const pinchDist = React.useRef<number | null>(null)
  const dragLast = React.useRef<number | null>(null)

  // data changed → an out-of-bounds window is invalid, treat as unzoomed
  const validRange = range !== null && range.end <= length - 1 ? range : null
  const current: ZoomRange = validRange ?? {
    start: 0,
    end: Math.max(0, length - 1),
  }
  const isZoomed = validRange !== null

  const clampWindow = React.useCallback(
    (start: number, end: number): ZoomRange => {
      const max = Math.max(0, length - 1)
      const size = Math.max(minWindow, Math.round(end - start) + 1)
      let s = Math.round(start)
      if (s < 0) s = 0
      if (s + size - 1 > max) s = max - size + 1
      if (s < 0) s = 0
      const e = Math.min(max, s + size - 1)
      return { start: s, end: e }
    },
    [length, minWindow]
  )

  const zoomAt = React.useCallback(
    (factor: number, anchorFrac: number) => {
      setRange((prev) => {
        const base = prev ?? { start: 0, end: Math.max(0, length - 1) }
        const size = base.end - base.start + 1
        const newSize = Math.round(size * factor)
        if (newSize >= length) return null
        const clamped = Math.max(minWindow, Math.min(newSize, length))
        const anchor = base.start + anchorFrac * (size - 1)
        const s = anchor - anchorFrac * (clamped - 1)
        return clampWindow(s, s + clamped - 1)
      })
    },
    [length, minWindow, clampWindow]
  )

  const pan = React.useCallback(
    (frac: number) => {
      setRange((prev) => {
        if (!prev) return null
        const size = prev.end - prev.start + 1
        const shift = Math.round(frac * size)
        return clampWindow(prev.start + shift, prev.end + shift)
      })
    },
    [clampWindow]
  )

  // wheel (non-passive): ctrlKey/trackpad-pinch = zoom, else = pan
  React.useEffect(() => {
    const el = wrapEl
    if (!el || length <= minWindow) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = el.getBoundingClientRect()
        const frac = Math.min(
          1,
          Math.max(0, (e.clientX - rect.left) / rect.width)
        )
        const factor = Math.exp(e.deltaY * 0.002)
        zoomAt(factor, frac)
      } else {
        e.preventDefault()
        pan(e.deltaY / 360)
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [wrapEl, length, minWindow, zoomAt, pan])

  const onPointerDown = React.useCallback((e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 1) {
      dragLast.current = e.clientX
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
    } else {
      pinchDist.current = null
      dragLast.current = null
    }
  }, [])

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent) => {
      const prev = pointers.current.get(e.pointerId)
      if (!prev) return
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinchDist.current !== null && dist > 0) {
          const rect = wrapEl?.getBoundingClientRect()
          const midX = (a.x + b.x) / 2
          const frac = rect
            ? Math.min(1, Math.max(0, (midX - rect.left) / rect.width))
            : 0.5
          zoomAt(pinchDist.current / dist, frac)
        }
        pinchDist.current = dist
      } else if (dragLast.current !== null) {
        const rect = wrapEl?.getBoundingClientRect()
        if (rect && rect.width > 0) {
          const size = (range?.end ?? length - 1) - (range?.start ?? 0) + 1
          const pxPerIndex = rect.width / size
          const deltaIdx = (dragLast.current - e.clientX) / pxPerIndex
          if (Math.abs(deltaIdx) >= 1) {
            pan(deltaIdx / size)
            dragLast.current = e.clientX
          }
        }
      }
    },
    [pan, zoomAt, range, length, wrapEl]
  )

  const endPointer = React.useCallback((e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchDist.current = null
    if (pointers.current.size === 0) {
      dragLast.current = null
    } else if (pointers.current.size === 1) {
      const [p] = [...pointers.current.values()]
      dragLast.current = p.x
    }
  }, [])

  const reset = React.useCallback(() => setRange(null), [])

  const slice = React.useCallback(
    <T>(data: T[]): T[] =>
      isZoomed ? data.slice(current.start, current.end + 1) : data,
    [isZoomed, current.start, current.end]
  )

  const wrapRef = React.useCallback(
    (node: HTMLDivElement | null) => setWrapEl(node),
    []
  )

  const handlers = React.useMemo(
    () => ({
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onPointerLeave: endPointer,
    }),
    [onPointerDown, onPointerMove, endPointer]
  )

  return {
    wrapRef,
    range: current,
    isZoomed,
    reset,
    slice,
    handlers,
  }
}
