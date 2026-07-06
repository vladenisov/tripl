import { useCallback, useMemo, useState } from 'react'

import type { EventListItem } from '@/types'

export function useEventsSelection({ events }: { events: EventListItem[] }) {
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([])

  const visibleEventIds = useMemo(
    () => events.map(event => event.id),
    [events],
  )
  const visibleIndexById = useMemo(() => {
    const map = new Map<string, number>()
    for (let i = 0; i < visibleEventIds.length; i += 1) {
      map.set(visibleEventIds[i], i)
    }
    return map
  }, [visibleEventIds])
  const visibleEventIdsSet = useMemo(() => new Set(visibleEventIds), [visibleEventIds])
  const selectedVisibleEventIds = useMemo(
    () => selectedEventIds.filter(eventId => visibleEventIdsSet.has(eventId)),
    [selectedEventIds, visibleEventIdsSet],
  )
  const allVisibleSelected = events.length > 0 && selectedVisibleEventIds.length === events.length
  const someVisibleSelected = selectedVisibleEventIds.length > 0
  const selectedSet = useMemo(() => new Set(selectedEventIds), [selectedEventIds])

  const toggleEventSelected = useCallback((eventId: string, checked: boolean) => {
    setSelectedEventIds(current => (
      checked
        ? (current.includes(eventId) ? current : [...current, eventId])
        : current.filter(id => id !== eventId)
    ))
  }, [])

  const toggleAllVisibleSelected = useCallback((checked: boolean) => {
    setSelectedEventIds(current => {
      if (!checked) {
        return current.filter(id => !visibleEventIdsSet.has(id))
      }
      const next = new Set(current)
      visibleEventIds.forEach(id => next.add(id))
      return Array.from(next)
    })
  }, [visibleEventIds, visibleEventIdsSet])

  // Select an explicit id set that may include events not currently loaded
  // (used by "select all N matching" to sweep the whole filtered result).
  const selectAll = useCallback((ids: string[]) => {
    setSelectedEventIds(ids)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedEventIds([])
  }, [])

  return {
    selectedEventIds,
    selectedCount: selectedEventIds.length,
    selectedVisibleEventIds,
    allVisibleSelected,
    someVisibleSelected,
    selectedSet,
    visibleEventIds,
    visibleIndexById,
    toggleEventSelected,
    toggleAllVisibleSelected,
    selectAll,
    clearSelection,
  }
}
