import { useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import type { EventListItem } from '@/types'
import type { useEventsQuery } from './useEventsQuery'

const VIRTUAL_THRESHOLD = 100
const ROW_H_ESTIMATE = 36

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
    estimateSize: () => ROW_H_ESTIMATE,
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

  useEffect(() => {
    if (!eventsQuery.hasNextPage || eventsQuery.isFetchingNextPage) return
    const lastVisible = virtualItems[virtualItems.length - 1]
    if (lastVisible && lastVisible.index >= events.length - 50) {
      void fetchNextPage()
    } else if (!virtualize && events.length > 0 && events.length < total) {
      void fetchNextPage()
    }
  }, [
    virtualItems,
    events.length,
    eventsQuery.hasNextPage,
    eventsQuery.isFetchingNextPage,
    fetchNextPage,
    virtualize,
    total,
  ])

  return {
    tableScrollRef,
    virtualize,
    virtualItems,
    totalVirtualSize,
  }
}
