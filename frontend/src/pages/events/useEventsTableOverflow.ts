import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, RefCallback } from 'react'

/**
 * Measured x-offset of the pinned EVENT column, published on the `<table>` so
 * the pinned cells can position themselves without every row re-rendering.
 */
const PIN_LEFT_VAR = '--tripl-events-pin-left'
/** `none`, or the shadow the pinned cluster casts once content scrolls under it. */
const PIN_SHADOW_VAR = '--tripl-events-pin-shadow'

/** Reorder handle (34px) + checkbox (40px) — the natural widths of the two
 *  utility columns left of EVENT, used until the real measurement lands. */
const PIN_LEFT_FALLBACK_PX = 74

// Tinted from --fg rather than a fixed black so the edge reads in both themes.
const PIN_SHADOW = '8px 0 10px -8px color-mix(in srgb, var(--fg) 30%, transparent)'

/**
 * Inline overrides for the pinned EVENT cell.
 *
 * `.tripl-pin-l` (index.css) already supplies `position: sticky` plus the
 * opaque default/hover/selected backgrounds a sticky cell needs; what it cannot
 * supply is this column's `left`, because that depends on the two utility
 * columns' rendered widths. Its `left: 0` and tight 2px/8px gutters belong to
 * the checkbox column, so both are overridden here.
 *
 * The EVENT *header* cell must also carry `data-pinned="true"` — that is what
 * the measurement below reads the offset from, and what keeps a column that
 * never leaves out of the off-screen count.
 */
export const PINNED_EVENT_CELL_STYLE: CSSProperties = {
  left: `var(${PIN_LEFT_VAR}, ${PIN_LEFT_FALLBACK_PX}px)`,
  boxShadow: `var(${PIN_SHADOW_VAR}, none)`,
  paddingLeft: 10,
  paddingRight: 10,
}

function measureOverflow(table: HTMLTableElement): number {
  const scroller = table.parentElement
  const headerCells = table.tHead?.rows[0]?.cells
  if (!scroller || !headerCells) return 0

  const { scrollLeft, clientWidth } = scroller
  table.style.setProperty(PIN_SHADOW_VAR, scrollLeft > 0 ? PIN_SHADOW : 'none')

  const pinned = Array.from(headerCells).find(cell => cell.dataset.pinned === 'true')
  if (pinned) table.style.setProperty(PIN_LEFT_VAR, `${pinned.offsetLeft}px`)
  // Everything left of this x is covered by the pinned cluster, not readable.
  const pinnedRight = pinned ? pinned.offsetLeft + pinned.offsetWidth : 0

  let offscreen = 0
  for (const cell of headerCells) {
    // Only headed data columns count. The reorder handle and the select-all
    // checkbox carry no label, and the pinned EVENT column never leaves.
    if (cell.dataset.pinned === 'true' || !cell.textContent?.trim()) continue
    const start = cell.offsetLeft - scrollLeft
    if (start < pinnedRight || start + cell.offsetWidth > clientWidth) offscreen += 1
  }
  return offscreen
}

/**
 * Tracks how much of the events table is outside its horizontal viewport.
 *
 * At 1512px the catalog is ~1665px of columns in a ~902px pane, so 8 of 17
 * columns sit off-screen (10 at 1280px) with nothing but the scrollbar — far
 * below the fold of a tall list — to say so (tripl-1uls / tripl-u1ib). The
 * count feeds the Columns chip; the scroll position drives the pinned columns'
 * shadow through a custom property, so crossing scrollLeft 0 repaints instead
 * of re-rendering every row.
 *
 * The scroller is the `<table>`'s parent: `Table` (components/ui/table.tsx)
 * wraps it in the `.tripl-scroll-x` container that actually overflows.
 */
export function useEventsTableOverflow(): {
  tableRef: RefCallback<HTMLTableElement>
  offscreenColumnCount: number
} {
  const [table, setTable] = useState<HTMLTableElement | null>(null)
  const [offscreenColumnCount, setOffscreenColumnCount] = useState(0)
  const tableRef = useCallback((node: HTMLTableElement | null) => setTable(node), [])

  useEffect(() => {
    const scroller = table?.parentElement
    if (!table || !scroller) return

    let frame = 0
    const measure = () => {
      frame = 0
      setOffscreenColumnCount(measureOverflow(table))
    }
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(measure)
    }

    measure()
    scroller.addEventListener('scroll', schedule, { passive: true })
    // Both edges move the answer: the pane resizing, and columns being toggled
    // on/off (which changes the table's own width).
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(scroller)
    observer?.observe(table)

    return () => {
      if (frame) cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', schedule)
      observer?.disconnect()
    }
  }, [table])

  return { tableRef, offscreenColumnCount }
}
