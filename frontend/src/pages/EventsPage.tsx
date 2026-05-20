import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { eventsApi } from '@/api/events'
import { eventTypesApi } from '@/api/eventTypes'
import { metaFieldsApi } from '@/api/metaFields'
import { variablesApi } from '@/api/variables'
import { useConfirm } from '@/hooks/useConfirm'
import { useVirtualizer } from '@tanstack/react-virtual'
import type {
  Event as TEvent,
  EventListItem,
  EventType,
} from '@/types'
import { ErrorState } from '@/components/error-state'

import { BulkActionBar } from './events/BulkActionBar'
import { EventForm } from './events/EventForm'
import { EventsHeader } from './events/EventsHeader'
import { EventsTable } from './events/EventsTable'
import { EventsToolbar } from './events/EventsToolbar'
import { TabMetricsCard } from './events/TabMetricsCard'
import { useColumnVisibility } from './events/useColumnVisibility'
import { useEventMutations } from './events/useEventMutations'
import { useEventRowActions } from './events/useEventRowActions'
import { useEventRowMetrics } from './events/useEventRowMetrics'
import { useEventsFiltering } from './events/useEventsFiltering'
import { useEventsQuery } from './events/useEventsQuery'
import { useEventsSignals } from './events/useEventsSignals'
import { useSavedViews } from './events/useSavedViews'
import {
  EMPTY_EVENT_TYPES,
  EMPTY_META_FIELDS,
  EMPTY_TAGS,
  EMPTY_VARIABLES,
} from './events/utils'
export default function EventsPage() {
  const { slug, tab: urlTab, eventId: urlEventId } = useParams<{ slug: string; tab?: string; eventId?: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // Derive active tab from URL (default 'all')
  const activeTab = urlTab || 'all'

  const [showForm, setShowForm] = useState(false)
  const [editingEvent, setEditingEvent] = useState<TEvent | null>(null)
  const [expandedCell, setExpandedCell] = useState<string | null>(null)
  const [openCharts, setOpenCharts] = useState<Record<string, boolean>>({})
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([])
  const { hiddenColumns, toggleColumn, colMenuOpen, setColMenuOpen } = useColumnVisibility()
  const {
    savedViews,
    savedViewName,
    setSavedViewName,
    activeSavedViewName,
    saveCurrentView,
    applySavedView,
    deleteSavedView,
  } = useSavedViews({ slug, activeTab })
  const { confirm, dialog } = useConfirm()

  // Open event from URL param
  const openEventId = urlEventId || null

  const eventTypesQuery = useQuery({
    queryKey: ['eventTypes', slug],
    queryFn: () => eventTypesApi.list(slug!),
    enabled: !!slug,
  })
  const eventTypes = eventTypesQuery.data ?? EMPTY_EVENT_TYPES
  const metaFieldsQuery = useQuery({
    queryKey: ['metaFields', slug],
    queryFn: () => metaFieldsApi.list(slug!),
    enabled: !!slug,
  })
  const metaFields = metaFieldsQuery.data ?? EMPTY_META_FIELDS
  const variablesQuery = useQuery({
    queryKey: ['variables', slug],
    queryFn: () => variablesApi.list(slug!),
    enabled: !!slug,
  })
  const variables = variablesQuery.data ?? EMPTY_VARIABLES
  const allTagsQuery = useQuery({
    queryKey: ['eventTags', slug],
    queryFn: () => eventsApi.tags(slug!),
    enabled: !!slug,
  })
  const allTags = allTagsQuery.data ?? EMPTY_TAGS

  const {
    search,
    setSearch,
    filterImplemented,
    setFilterImplemented,
    filterTag,
    setFilterTag,
    filterReviewed,
    filterReviewedForQuery,
    filterArchivedForQuery,
    filterSilentDays,
    setFilterSilentDays,
    fieldFilters,
    updateFieldFilter,
    metaFilters,
    updateMetaFilter,
    debouncedSearch,
    debouncedFieldFilters,
    debouncedMetaFilters,
    isFilterPending,
    filterEtId,
    eventsQuery,
    rawEvents,
    total,
  } = useEventsQuery({ slug, activeTab, eventTypes })

  const { projectTotalSignal, eventTypeSignals, eventSignals } = useEventsSignals({
    slug,
    rawEvents,
  })

  const unreviewedDataQuery = useQuery({
    queryKey: ['events', slug, 'unreviewedCount'],
    queryFn: () => eventsApi.list(slug!, { reviewed: false, archived: false, limit: 1 }),
    enabled: !!slug,
  })
  const unreviewedCount = unreviewedDataQuery.data?.total ?? 0

  // Load event from URL if eventId is present
  const urlEventQuery = useQuery({
    queryKey: ['event', slug, openEventId],
    queryFn: () => eventsApi.get(slug!, openEventId!),
    enabled: !!slug && !!openEventId,
  })
  const urlEvent = urlEventQuery.data

  const openEvent = useCallback((ev: EventListItem) => {
    navigate(`/p/${slug}/events/${activeTab}/${ev.id}${searchParams.toString() ? `?${searchParams}` : ''}`)
  }, [slug, activeTab, navigate, searchParams])

  const closeEvent = useCallback(() => {
    const path = activeTab === 'all' ? `/p/${slug}/events` : `/p/${slug}/events/${activeTab}`
    navigate(path + (searchParams.toString() ? `?${searchParams}` : ''), { replace: true })
    setShowForm(false)
    setEditingEvent(null)
  }, [slug, activeTab, navigate, searchParams])

  const mutations = useEventMutations({
    slug,
    onBulkDeleteOptimistic: () => setSelectedEventIds([]),
  })
  const { bulkDeleteMut } = mutations

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const activeEt = eventTypes.find((e: EventType) => e.name === activeTab) ?? null
  const openedEvent = openEventId ? (urlEvent ?? null) : editingEvent
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

  const {
    fieldColumns,
    eventTypesById,
    fieldEnumOptions,
    metaValuesByEvent,
    getFieldValue,
    events,
  } = useEventsFiltering({
    rawEvents,
    eventTypes,
    metaFields,
    activeEt,
    debouncedFieldFilters,
    debouncedMetaFilters,
  })

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

  // Row virtualization — kicks in past VIRTUAL_THRESHOLD events, leaving small lists
  // and tests (jsdom can't measure layout) on the plain full-render path.
  const VIRTUAL_THRESHOLD = 100
  const ROW_H_ESTIMATE = 36
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const virtualize = events.length > VIRTUAL_THRESHOLD
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: virtualize ? events.length : 0,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => ROW_H_ESTIMATE,
    overscan: 12,
    // Tie virtual slots to event ids so the virtualizer's measurement cache
    // and scroll position survive cache patches (optimistic toggle/delete,
    // reorder) and filter changes that shuffle items.
    getItemKey: (index) => events[index]?.id ?? index,
  })
  const rawVirtualItems = rowVirtualizer.getVirtualItems()
  // Memoize so the conditional .getVirtualItems() call doesn't mint a new []
  // every render, which would re-fire the auto-fetch effect below on every
  // tick.
  const virtualItems = useMemo(
    () => (virtualize ? rawVirtualItems : []),
    [virtualize, rawVirtualItems],
  )
  const totalVirtualSize = virtualize ? rowVirtualizer.getTotalSize() : 0

  // Auto-fetch the next page when the virtualizer is rendering rows close to
  // the end of the loaded list. The 50-row prefetch margin keeps scrolling
  // smooth without prefetching unnecessarily.
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
  const colCount =
    1 /* drag handle */ +
    1 /* checkbox */ +
    1 /* event */ +
    (activeEt ? 0 : 1) /* type */ +
    1 /* 48h */ +
    (hideTags ? 0 : 1) /* tags */ +
    (hideLastSeen ? 0 : 1) /* last seen */ +
    visibleFieldColumns.length +
    visibleMetaFields.length +
    1 /* actions */

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

  const selectedSet = useMemo(() => new Set(selectedEventIds), [selectedEventIds])

  const onToggleExpandedCell = useCallback((cellKey: string | null) => {
    setExpandedCell(prev => (prev === cellKey ? null : cellKey))
  }, [])

  const { handleDragEnd, onRowAction } = useEventRowActions({
    slug,
    navigate,
    openEvent,
    mutations,
    confirm,
    visibleEventIds,
  })

  const handleBulkDelete = useCallback(async () => {
    if (!selectedVisibleEventIds.length) return
    const ok = await confirm({
      title: 'Delete selected events',
      message: `Delete ${selectedVisibleEventIds.length} selected events?`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) bulkDeleteMut.mutate(selectedVisibleEventIds)
  }, [bulkDeleteMut, confirm, selectedVisibleEventIds])

  const hasActiveFilters = filterImplemented !== undefined || filterTag !== '' || filterReviewed !== undefined || filterSilentDays !== undefined ||
    Object.values(fieldFilters).some(v => v !== '') ||
    Object.values(metaFilters).some(v => v !== '')

  const { eventWindowMetricsByEvent, eventRowSignals } = useEventRowMetrics({
    slug,
    events,
    eventSignals,
  })

  const clearAllFilters = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('implemented')
      next.delete('reviewed')
      next.delete('tag')
      next.delete('silent_days')
      Array.from(next.keys()).filter(k => k.startsWith('f.') || k.startsWith('m.')).forEach(k => next.delete(k))
      return next
    }, { replace: true })
  }

  const blockingError =
    eventsQuery.error ??
    eventTypesQuery.error ??
    metaFieldsQuery.error ??
    variablesQuery.error ??
    allTagsQuery.error ??
    urlEventQuery.error

  return (
    <div className="flex min-h-[calc(100vh-7rem)] flex-col">
      {dialog}

      <EventsHeader
        total={total}
        unreviewedCount={unreviewedCount}
        projectTotalSignal={projectTotalSignal}
        eventTypeSignals={eventTypeSignals}
        onNewEvent={() => {
          if (openEventId) {
            const path = activeTab === 'all' ? `/p/${slug}/events` : `/p/${slug}/events/${activeTab}`
            navigate(path + (searchParams.toString() ? `?${searchParams}` : ''), { replace: true })
          }
          setEditingEvent(null)
          setShowForm(v => !v)
        }}
      />

      {blockingError && (
        <ErrorState
          title="Failed to load events"
          description="The events page could not fetch the required data from the backend."
          error={blockingError}
          onRetry={() => {
            const refetches: Promise<unknown>[] = [
              eventsQuery.refetch(),
              eventTypesQuery.refetch(),
              metaFieldsQuery.refetch(),
              variablesQuery.refetch(),
              allTagsQuery.refetch(),
              unreviewedDataQuery.refetch(),
            ]
            if (openEventId) {
              refetches.push(urlEventQuery.refetch())
            }
            void Promise.all(refetches)
          }}
        />
      )}

      {!blockingError && (
        <>
          <EventsToolbar
            search={search}
            onSearchChange={setSearch}
            isFilterPending={isFilterPending}
            filterImplemented={filterImplemented}
            onFilterImplementedChange={setFilterImplemented}
            filterSilentDays={filterSilentDays}
            onFilterSilentDaysChange={setFilterSilentDays}
            hasActiveFilters={hasActiveFilters}
            onClearFilters={clearAllFilters}
            savedViews={savedViews}
            activeSavedViewName={activeSavedViewName}
            savedViewName={savedViewName}
            onSavedViewNameChange={setSavedViewName}
            onSaveCurrentView={saveCurrentView}
            onApplySavedView={applySavedView}
            onDeleteSavedView={deleteSavedView}
            columnsMenuOpen={colMenuOpen}
            onColumnsMenuOpenChange={setColMenuOpen}
            hiddenColumns={hiddenColumns}
            hideLastSeen={hideLastSeen}
            fieldColumns={fieldColumns}
            metaFields={metaFields}
            onToggleColumn={toggleColumn}
          />

      <BulkActionBar
        selectedCount={selectedVisibleEventIds.length}
        isDeleting={bulkDeleteMut.isPending}
        onDelete={() => { void handleBulkDelete() }}
        onClear={() => setSelectedEventIds([])}
      />

      {/* Event Form (Sheet) */}
      {(showForm || openedEvent) && slug && (
        <EventForm
          slug={slug}
          eventTypes={eventTypes}
          metaFields={metaFields}
          projectVariables={variables}
          event={openedEvent}
          defaultEventTypeId={activeEt?.id}
          onClose={closeEvent}
        />
      )}

      {slug && (
        <TabMetricsCard
          slug={slug}
          activeEt={activeEt}
          activeTabLabel={activeTabLabel}
          activeTabSignal={activeTabSignal}
          isOpen={isTabChartOpen}
          onOpenChange={setIsTabChartOpen}
          filters={{
            filterEtId,
            debouncedSearch,
            filterImplemented,
            filterTag,
            filterReviewedForQuery,
            filterArchivedForQuery,
          }}
        />
      )}

      {/* Events Table */}
      <EventsTable
        tableScrollRef={tableScrollRef}
        isTabChartOpen={isTabChartOpen}
        dndSensors={dndSensors}
        handleDragEnd={handleDragEnd}
        visibleEventIds={visibleEventIds}
        allVisibleSelected={allVisibleSelected}
        someVisibleSelected={someVisibleSelected}
        toggleAllVisibleSelected={toggleAllVisibleSelected}
        activeEt={activeEt}
        hideTags={hideTags}
        hideLastSeen={hideLastSeen}
        allTags={allTags}
        filterTag={filterTag}
        setFilterTag={setFilterTag}
        visibleFieldColumns={visibleFieldColumns}
        fieldFilters={fieldFilters}
        updateFieldFilter={updateFieldFilter}
        fieldEnumOptions={fieldEnumOptions}
        visibleMetaFields={visibleMetaFields}
        metaFilters={metaFilters}
        updateMetaFilter={updateMetaFilter}
        events={events}
        virtualize={virtualize}
        virtualItems={virtualItems}
        totalVirtualSize={totalVirtualSize}
        colCount={colCount}
        expandedCell={expandedCell}
        eventWindowMetricsByEvent={eventWindowMetricsByEvent}
        eventRowSignals={eventRowSignals}
        metaValuesByEvent={metaValuesByEvent}
        eventTypesById={eventTypesById}
        slug={slug!}
        selectedSet={selectedSet}
        visibleIndexById={visibleIndexById}
        getFieldValue={getFieldValue}
        toggleEventSelected={toggleEventSelected}
        onToggleExpandedCell={onToggleExpandedCell}
        onRowAction={onRowAction}
      />
        </>
      )}
    </div>
  )
}
