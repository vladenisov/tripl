import { useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import { useTheme, type Density } from '@/components/theme-provider'
import type { EventListItem } from '@/types'
import type { useEventsQuery } from './useEventsQuery'

const VIRTUAL_THRESHOLD = 100

/**
 * `--row-h` per density class (index.css). The estimate has to follow the
 * density the theme applies: a fixed 36px was 30% too tall under the default
 * compact density, so the spacers mis-mapped the scrollbar and the next-page
 * trigger fired early (EVT-17). Rows are still measured once rendered — an
 * expanded JSON cell makes one several times taller — this only sizes the rows
 * not rendered yet.
 */
export const ROW_HEIGHT_BY_DENSITY: Record<Density, number> = {
  compact: 28,
  cozy: 36,
  comfy: 44,
}

/**
 * Whether the table should ask for the next page right now.
 *
 * A virtualized list pages as the viewport nears the end of what is loaded. A
 * short list pages eagerly so every row is on screen. Under a client-side
 * field/meta filter the loaded page can hold zero matches while later pages
 * hold many, so the sweep keeps going regardless of how many rows matched so
 * far; stopping at an empty page showed "No events match" over a catalog that
 * had them (EVT-4).
 */
export function shouldFetchNextPage({
  hasNextPage,
  isFetchingNextPage,
  virtualize,
  isClientFiltered,
  loadedCount,
  lastVisibleIndex,
}: {
  hasNextPage: boolean
  isFetchingNextPage: boolean
  virtualize: boolean
  isClientFiltered: boolean
  /** Rows the table holds (after any client-side filter). */
  loadedCount: number
  /** Index of the last rendered virtual row, when virtualizing. */
  lastVisibleIndex: number | undefined
}): boolean {
  if (!hasNextPage || isFetchingNextPage) return false
  if (lastVisibleIndex !== undefined && lastVisibleIndex >= loadedCount - 50) return true
  if (!virtualize) return loadedCount > 0 || isClientFiltered
  return false
}

/**
 * Row count the virtualizer sizes its scroll spacer to. Use the server `total`
 * (not the loaded-so-far page length) so the spacer is full-height from the
 * first paint and the scrollbar maps linearly to every row; rows past the
 * loaded set render as placeholders until their page streams in. Client-side
 * field/meta filters narrow the loaded rows without a matching server count, so
 * fall back to the filtered length there. Returns 0 when not virtualizing.
 */
export function computeVirtualRowCount({
  virtualize,
  isClientFiltered,
  loadedCount,
  total,
}: {
  virtualize: boolean
  isClientFiltered: boolean
  loadedCount: number
  total: number
}): number {
  if (!virtualize) return 0
  if (isClientFiltered) return loadedCount
  return Math.max(loadedCount, total)
}

export function useEventsTableVirtualization({
  events,
  total,
  eventsQuery,
  isClientFiltered,
}: {
  events: EventListItem[]
  total: number
  eventsQuery: ReturnType<typeof useEventsQuery>['eventsQuery']
  isClientFiltered: boolean
}) {
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const { density } = useTheme()
  const rowHeightEstimate = ROW_HEIGHT_BY_DENSITY[density] ?? ROW_HEIGHT_BY_DENSITY.cozy
  const virtualize = events.length > VIRTUAL_THRESHOLD
  // Size the scroll spacer to the FULL known row count up front so the
  // scrollbar maps linearly to every row from the first paint. The list is
  // paginated (200/page) and appended as the user scrolls, so `events.length`
  // only reflects the rows loaded so far — sizing the virtualizer to it made
  // the spacer grow one page at a time (scrollHeight ~7k → 14k → 21k px), so
  // dragging the thumb to the bottom landed mid-list and the true end needed
  // many repeated drags. Use the server `total` instead; rows past the loaded
  // set render as height-preserving placeholders until their page streams in.
  // Client-side field/meta filters narrow the loaded rows without a matching
  // server count, so fall back to the filtered length in that mode.
  const rowCount = computeVirtualRowCount({
    virtualize,
    isClientFiltered,
    loadedCount: events.length,
    total,
  })
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => rowHeightEstimate,
    overscan: 12,
    getItemKey: (index) => events[index]?.id ?? index,
  })
  const rawVirtualItems = rowVirtualizer.getVirtualItems()
  const virtualItems = useMemo(
    () => (virtualize ? rawVirtualItems : []),
    [virtualize, rawVirtualItems],
  )
  const totalVirtualSize = virtualize ? rowVirtualizer.getTotalSize() : 0
  const fetchNextPage = eventsQuery.fetchNextPage

  // The estimate changes with density; re-measure so the spacers follow.
  useEffect(() => {
    rowVirtualizer.measure()
  }, [rowVirtualizer, rowHeightEstimate])

  const lastVisibleIndex = virtualItems[virtualItems.length - 1]?.index
  const wantsNextPage = shouldFetchNextPage({
    hasNextPage: eventsQuery.hasNextPage,
    isFetchingNextPage: eventsQuery.isFetchingNextPage,
    virtualize,
    isClientFiltered,
    loadedCount: events.length,
    lastVisibleIndex,
  })
  useEffect(() => {
    if (wantsNextPage) void fetchNextPage()
  }, [wantsNextPage, fetchNextPage, events.length])

  // The rows actually inside the scroll viewport, for the footer's "Showing
  // X–Y". `virtualItems` also holds the overscan rows either side, so the range
  // read off them was up to 24 rows wider than what was on screen (EVT-16).
  const scrollOffset = rowVirtualizer.scrollOffset ?? 0
  const viewportHeight = rowVirtualizer.scrollRect?.height ?? 0
  const onScreen = virtualItems.filter(
    item => item.end > scrollOffset && item.start < scrollOffset + viewportHeight,
  )
  const visibleRange =
    virtualize && onScreen.length > 0
      ? { first: onScreen[0].index, last: onScreen[onScreen.length - 1].index }
      : null

  return {
    tableScrollRef,
    virtualize,
    /** Zero-based first/last row index inside the viewport, when virtualized. */
    visibleRange,
    virtualItems,
    totalVirtualSize,
    /** Ref for a rendered row (with `data-index`) so its real height is used. */
    measureRow: rowVirtualizer.measureElement,
    /** A client-side filter is still sweeping unloaded pages for matches. */
    isScanningForMatches: isClientFiltered && eventsQuery.hasNextPage,
  }
}
