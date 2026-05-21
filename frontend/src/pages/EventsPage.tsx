import { useCallback, useMemo, useState } from 'react'
import { useConfirm } from '@/hooks/useConfirm'
import { ErrorState } from '@/components/error-state'

import { BulkActionBar } from './events/BulkActionBar'
import { EventForm } from './events/EventForm'
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

export default function EventsPage() {
  const {
    activeTab,
    closeEvent,
    editingEvent,
    navigate,
    openEvent,
    openEventId,
    openNewEvent,
    showForm,
    slug,
  } = useEventsRouteState()
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
    variables,
    allTags,
    unreviewedCount,
    urlEvent,
    dataError,
    refetchPageData,
  } = useEventsPageData({ slug, openEventId })

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
    hideLastSeen,
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
    filterImplemented,
    filterReviewed,
    filterSilentDays,
    filterTag,
    hiddenColumns,
    metaFields,
    metaFilters,
    projectTotalSignal,
  })

  const {
    selectedVisibleEventIds,
    allVisibleSelected,
    someVisibleSelected,
    selectedSet,
    visibleEventIds,
    visibleIndexById,
    toggleEventSelected,
    toggleAllVisibleSelected,
    clearSelection,
  } = useEventsSelection({ events })

  const mutations = useEventMutations({
    slug,
    onBulkDeleteOptimistic: clearSelection,
  })
  const { bulkDeleteMut } = mutations

  const dndSensors = useEventsDndSensors()

  const openedEvent = openEventId ? (urlEvent ?? null) : editingEvent

  const {
    tableScrollRef,
    virtualize,
    virtualItems,
    totalVirtualSize,
  } = useEventsTableVirtualization({ events, total, eventsQuery })

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

  const handleBulkDelete = useEventsBulkDelete({
    selectedVisibleEventIds,
    bulkDeleteMut,
    confirm,
  })

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

  return (
    <div className="flex min-h-[calc(100vh-7rem)] flex-col">
      {dialog}

      <EventsHeader
        total={total}
        unreviewedCount={unreviewedCount}
        projectTotalSignal={projectTotalSignal}
        eventTypeSignals={eventTypeSignals}
        onNewEvent={openNewEvent}
      />

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
            onClear={clearSelection}
          />

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
