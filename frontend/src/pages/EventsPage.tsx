import { useCallback, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { usersApi } from '@/api/users'
import { useConfirm } from '@/hooks/useConfirm'
import { useActiveBranchId } from '@/hooks/useBranch'
import { ErrorState } from '@/components/error-state'
import type { EventStatus } from '@/lib/eventStatus'

import { BulkActionBar } from './events/BulkActionBar'
import { EventsHeader } from './events/EventsHeader'
import { EventsTable } from './events/EventsTable'
import { EventsToolbar } from './events/EventsToolbar'
import { TabMetricsCard } from './events/TabMetricsCard'
import { useColumnVisibility } from './events/useColumnVisibility'
import { useEventsBulkDelete } from './events/useEventsBulkDelete'
import { useEventsDndSensors } from './events/useEventsDndSensors'
import { useEventMutations } from './events/useEventMutations'
import { useEventRowActions } from './events/useEventRowActions'
import { useEventsPageData } from './events/useEventsPageData'
import { useEventRowMetrics } from './events/useEventRowMetrics'
import { useEventsFiltering } from './events/useEventsFiltering'
import { useEventsQuery } from './events/useEventsQuery'
import { useEventsRouteState } from './events/useEventsRouteState'
import { useEventsSelection } from './events/useEventsSelection'
import { useEventsSignals } from './events/useEventsSignals'
import { useEventsTableVirtualization } from './events/useEventsTableVirtualization'
import { useEventsViewState } from './events/useEventsViewState'
import { useSavedViews } from './events/useSavedViews'

interface EventsPageProps {
  /** Lock the page to a single event type (by name), decoupling it from the
   *  `:tab` route segment. Set when embedding the table in another surface. */
  lockType?: string
  /** Embedded mode: hide the page-level header + aggregate chart and drop the
   *  full-height min-height so the table fits inside a host container/tab. */
  embedded?: boolean
}

export default function EventsPage({ lockType, embedded = false }: EventsPageProps = {}) {
  const {
    activeTab,
    navigate,
    openEvent,
    openEventId,
    openNewEvent,
    showForm,
    slug,
  } = useEventsRouteState(lockType)
  const branchId = useActiveBranchId()
  const usersQuery = useQuery({ queryKey: ['users'], queryFn: () => usersApi.list() })
  const usersById = useMemo(
    () =>
      new Map(
        (usersQuery.data ?? []).map((u) => [u.id, { name: u.name, email: u.email }]),
      ),
    [usersQuery.data],
  )
  const [expandedCell, setExpandedCell] = useState<string | null>(null)
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
  const {
    eventTypes,
    metaFields,
    allTags,
    unreviewedCount,
    dataError,
    refetchPageData,
  } = useEventsPageData({ slug, openEventId, branchId })

  const {
    search,
    setSearch,
    filterStatuses,
    setFilterStatuses,
    filterTag,
    setFilterTag,
    filterSilentDays,
    setFilterSilentDays,
    sort,
    setSort,
    fieldFilters,
    updateFieldFilter,
    metaFilters,
    updateMetaFilter,
    debouncedSearch,
    debouncedFieldFilters,
    debouncedMetaFilters,
    isFilterPending,
    filterEtId,
    queryStatuses,
    eventsQuery,
    rawEvents,
    total,
    fetchAllMatchingIds,
  } = useEventsQuery({ slug, activeTab, eventTypes, branchId })

  const { projectTotalSignal, eventTypeSignals, eventSignals } = useEventsSignals({
    slug,
    rawEvents,
  })

  const activeEt = useMemo(
    () => eventTypes.find(e => e.name === activeTab) ?? null,
    [activeTab, eventTypes],
  )

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

  const {
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
  } = useEventsViewState({
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
  })

  const {
    selectedEventIds,
    selectedCount,
    allVisibleSelected,
    someVisibleSelected,
    selectedSet,
    visibleEventIds,
    toggleEventSelected,
    toggleAllVisibleSelected,
    selectAll,
    clearSelection,
  } = useEventsSelection({ events })

  const mutations = useEventMutations({
    slug,
    branchId,
    onBulkDeleteOptimistic: clearSelection,
    onBulkUpdateOptimistic: clearSelection,
  })
  const { bulkDeleteMut, bulkUpdateMut } = mutations

  const dndSensors = useEventsDndSensors()

  const {
    tableScrollRef,
    virtualize,
    virtualItems,
    totalVirtualSize,
  } = useEventsTableVirtualization({
    events,
    total,
    eventsQuery,
    // `useEventsFiltering` returns the exact `rawEvents` reference when no
    // client-side field/meta filter is active and a fresh filtered array
    // otherwise, so identity tells the virtualizer whether the server `total`
    // is still authoritative for spacer sizing.
    isClientFiltered: events !== rawEvents,
  })

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
    selectedSet,
  })

  const handleBulkDelete = useEventsBulkDelete({
    selectedVisibleEventIds: selectedEventIds,
    bulkDeleteMut,
    confirm,
  })

  // Bulk actions operate on the FULL selection (`selectedEventIds`), not just
  // the loaded rows, so "select all N matching" can sweep events that have not
  // scrolled into view yet.
  const handleBulkSetStatus = useCallback((status: EventStatus) => {
    if (!selectedEventIds.length) return
    bulkUpdateMut.mutate({ eventIds: selectedEventIds, status })
  }, [bulkUpdateMut, selectedEventIds])

  const handleBulkMarkReviewed = useCallback(() => {
    if (!selectedEventIds.length) return
    bulkUpdateMut.mutate({ eventIds: selectedEventIds, reviewed: true })
  }, [bulkUpdateMut, selectedEventIds])

  // Pull every id matching the current filters/tab and select them, so triage
  // can accept or archive an entire prefix/queue in one bulk action.
  const [isSelectingAll, setIsSelectingAll] = useState(false)
  const handleSelectAllMatching = useCallback(async () => {
    setIsSelectingAll(true)
    try {
      const ids = await fetchAllMatchingIds()
      if (ids.length) selectAll(ids)
    } finally {
      setIsSelectingAll(false)
    }
  }, [fetchAllMatchingIds, selectAll])

  const handleBulkAssignOwner = useCallback((userId: string) => {
    if (!selectedEventIds.length) return
    bulkUpdateMut.mutate({ eventIds: selectedEventIds, owner_id: userId })
  }, [bulkUpdateMut, selectedEventIds])

  const { eventWindowMetricsByEvent, eventRowSignals } = useEventRowMetrics({
    slug,
    events,
    eventSignals,
  })

  const retryLoad = useCallback(() => {
    void Promise.all([
      eventsQuery.refetch(),
      ...refetchPageData(),
    ])
  }, [eventsQuery, refetchPageData])

  const blockingError = eventsQuery.error ?? dataError

  // Editing is a full page, not an inline Sheet. The "New event" action toggles
  // showForm and "Edit"/row-edit navigates to /events/:tab/:eventId; both are
  // redirected here to the dedicated new/edit routes.
  // Always keep the :tab segment so the new/edit routes (/events/:tab/new and
  // /events/:tab/:eventId/edit) match — '/events/new' would otherwise resolve to
  // the /events/:tab list route with tab='new'. tab='all' is handled everywhere.
  const eventsBase = `/p/${slug}/events/${activeTab}`
  if (slug && showForm) {
    return <Navigate to={`${eventsBase}/new`} replace />
  }
  if (slug && openEventId) {
    return <Navigate to={`${eventsBase}/${openEventId}/edit`} replace />
  }

  return (
    <div className={embedded ? 'flex min-h-[420px] flex-col' : 'flex min-h-[calc(100vh-7rem)] flex-col'}>
      {dialog}

      {!embedded && (
        <EventsHeader
          total={total}
          unreviewedCount={unreviewedCount}
          projectTotalSignal={projectTotalSignal}
          eventTypeSignals={eventTypeSignals}
          activeType={activeEt}
        />
      )}

      {blockingError && (
        <ErrorState
          title="Failed to load events"
          description="The events page could not fetch the required data from the backend."
          error={blockingError}
          onRetry={retryLoad}
        />
      )}

      {!blockingError && (
        <>
          <EventsToolbar
            search={search}
            onSearchChange={setSearch}
            isFilterPending={isFilterPending}
            filterStatuses={filterStatuses}
            onFilterStatusesChange={setFilterStatuses}
            filterSilentDays={filterSilentDays}
            onFilterSilentDaysChange={setFilterSilentDays}
            sortOrder={sort}
            onSortOrderChange={setSort}
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
            onNewEvent={openNewEvent}
          />

          <BulkActionBar
            selectedCount={selectedCount}
            matchingTotal={total}
            onSelectAllMatching={handleSelectAllMatching}
            isSelectingAll={isSelectingAll}
            isDeleting={bulkDeleteMut.isPending}
            isUpdating={bulkUpdateMut.isPending}
            onSetStatus={handleBulkSetStatus}
            onMarkReviewed={handleBulkMarkReviewed}
            onAssignOwner={handleBulkAssignOwner}
            owners={usersQuery.data ?? []}
            onDelete={() => { void handleBulkDelete() }}
            onClear={clearSelection}
          />

          {slug && !embedded && (
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
                queryStatuses,
                filterTag,
              }}
            />
          )}

          <div
            className="rounded-[10px] border overflow-hidden"
            style={{ borderColor: 'var(--border)' }}
          >
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
              hideStatus={hideStatus}
              hideReviewed={hideReviewed}
              hideMonitor={hideMonitor}
              hideOwner={hideOwner}
              hideDelta={hideDelta}
              usersById={usersById}
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
              total={total}
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
              getFieldValue={getFieldValue}
              toggleEventSelected={toggleEventSelected}
              onToggleExpandedCell={onToggleExpandedCell}
              onRowAction={onRowAction}
            />
          </div>
        </>
      )}
    </div>
  )
}
