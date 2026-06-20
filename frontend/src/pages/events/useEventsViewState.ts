import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import type {
  EventType,
  FieldDefinition,
  MetaFieldDefinition,
  MonitoringSignal,
} from '@/types'
import type { EventStatus } from '@/lib/eventStatus'

export function useEventsViewState({
  activeTab,
  activeEt,
  eventTypeSignals,
  fieldColumns,
  fieldFilters,
  filterStatuses,
  filterSilentDays,
  filterTag,
  hiddenColumns,
  metaFields,
  metaFilters,
  projectTotalSignal,
}: {
  activeTab: string
  activeEt: EventType | null
  eventTypeSignals: Map<string, MonitoringSignal>
  fieldColumns: FieldDefinition[]
  fieldFilters: Record<string, string>
  filterStatuses: EventStatus[]
  filterSilentDays: number | undefined
  filterTag: string
  hiddenColumns: Set<string>
  metaFields: MetaFieldDefinition[]
  metaFilters: Record<string, string>
  projectTotalSignal: MonitoringSignal | null
}) {
  const [, setSearchParams] = useSearchParams()
  const [openCharts, setOpenCharts] = useState<Record<string, boolean>>({})

  const isTabChartOpen = openCharts[activeTab] ?? false
  const setIsTabChartOpen = useCallback((open: boolean) => {
    setOpenCharts(prev => ({ ...prev, [activeTab]: open }))
  }, [activeTab])
  const activeTabSignal = useMemo(() => {
    if (activeTab === 'all') return projectTotalSignal
    if (!activeEt) return null
    return eventTypeSignals.get(activeEt.id) ?? null
  }, [activeEt, activeTab, eventTypeSignals, projectTotalSignal])
  const activeTabLabel = useMemo(() => {
    if (activeEt) return activeEt.display_name
    if (activeTab === 'review') return 'Review Queue'
    if (activeTab === 'archived') return 'Archived Events'
    return 'All Events'
  }, [activeEt, activeTab])

  const visibleFieldColumns = useMemo(
    () => fieldColumns.filter(f => !hiddenColumns.has(`f:${f.id}`)),
    [fieldColumns, hiddenColumns],
  )
  const visibleMetaFields = useMemo(
    () => metaFields.filter(mf => !hiddenColumns.has(`m:${mf.id}`)),
    [metaFields, hiddenColumns],
  )
  const hideTags = hiddenColumns.has('tags')
  const hideLastSeen = hiddenColumns.has('last_seen')
  const hideStatus = hiddenColumns.has('status')
  const hideReviewed = hiddenColumns.has('reviewed')
  const hideMonitor = hiddenColumns.has('monitor')
  const hideOwner = hiddenColumns.has('owner')
  const hideDelta = hiddenColumns.has('delta')
  const colCount =
    1 +
    1 +
    1 +
    (activeEt ? 0 : 1) +
    (hideStatus ? 0 : 1) +
    (hideReviewed ? 0 : 1) +
    (hideMonitor ? 0 : 1) +
    (hideDelta ? 0 : 1) +
    1 +
    (hideTags ? 0 : 1) +
    (hideLastSeen ? 0 : 1) +
    (hideOwner ? 0 : 1) +
    visibleFieldColumns.length +
    visibleMetaFields.length

  const hasActiveFilters = filterStatuses.length > 0 || filterTag !== '' || filterSilentDays !== undefined ||
    Object.values(fieldFilters).some(v => v !== '') ||
    Object.values(metaFilters).some(v => v !== '')

  const clearAllFilters = useCallback(() => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('status')
      next.delete('tag')
      next.delete('silent_days')
      Array.from(next.keys()).filter(k => k.startsWith('f.') || k.startsWith('m.')).forEach(k => next.delete(k))
      return next
    }, { replace: true })
  }, [setSearchParams])

  return {
    activeTabLabel,
    activeTabSignal,
    clearAllFilters,
    colCount,
    hasActiveFilters,
    hideDelta,
    hideLastSeen,
    hideMonitor,
    hideOwner,
    hideReviewed,
    hideStatus,
    hideTags,
    isTabChartOpen,
    setIsTabChartOpen,
    visibleFieldColumns,
    visibleMetaFields,
  }
}
