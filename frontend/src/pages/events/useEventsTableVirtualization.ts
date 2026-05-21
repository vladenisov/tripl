import { useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import type { EventListItem } from '@/types'
import type { useEventsQuery } from './useEventsQuery'

const VIRTUAL_THRESHOLD = 100
const ROW_H_ESTIMATE = 36

export function useEventsTableVirtualization({
  events,
  total,
  eventsQuery,
}: {
  events: EventListItem[]
  total: number
  eventsQuery: ReturnType<typeof useEventsQuery>['eventsQuery']
}) {
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const virtualize = events.length > VIRTUAL_THRESHOLD
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: virtualize ? events.length : 0,
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
