import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Inbox, Layers, ListPlus, Loader2, Plus } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  type DragEndEvent,
  type SensorDescriptor,
  type SensorOptions,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import type { VirtualItem } from '@tanstack/react-virtual'
import { variablesApi } from '@/api/variables'
import { useActiveBranchId } from '@/hooks/useBranch'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Dot } from '@/components/primitives/dot'
import { EmptyState } from '@/components/empty-state'
import type {
  EventFieldValue,
  EventListItem,
  EventType,
  EventTypeBrief,
  EventWindowMetrics,
  FieldDefinition,
  MetaFieldDefinition,
  MonitoringSignal,
} from '@/types'

import { ColumnFilter, FilterableHead, type ColumnFilterType } from './ColumnFilter'
import { eventsEmptyCopy, type EventsEmptyContext } from './emptyState'
import { EventRow, type RowAction } from './EventRow'
import {
  TABLE_CLUSTER_MIN_SIZE,
  groupEventNames,
  isDeepPrefix,
  type EventNameGroup,
} from './eventNameGroups'
import { PINNED_EVENT_CELL_STYLE } from './useEventsTableOverflow'
import { PHONE_FULL_ROW, PHONE_HEADER_ROW, PHONE_TABLE } from './eventsPhoneCard'
import { EMPTY_WINDOW_POINTS, ROW_METRICS_LABEL } from './utils'
import { variablesKey } from '@/lib/queryKeys'
import { useCanWriteProject } from '@/lib/permissions'

/** Cap the cluster list so the summary header stays compact; the rest fold into a count. */
const MAX_VISIBLE_CLUSTERS = 6

// The "*" a Δ cell prints needs a legend somewhere. It is the only mark a reader
// sees when collection lags and a 24h window is short of its hours (tripl-oooj:
// the demo's series ends ~2h before now, so the recent window covers 22 of 24),
// and the per-cell tooltip is only reachable once you already suspect something.
const DELTA_HEAD_HELP =
  'Δ · 24h — change in volume versus the previous 24-hour window. A * marks a window the collected series does not fully cover; hover the value for what it does cover.'

export type EventsTableProps = {
  // Layout
  tableScrollRef: React.RefObject<HTMLDivElement | null>
  /** Hands the `<table>` to `useEventsTableOverflow` (owned by the page, since
   *  the toolbar's Columns chip reports the off-screen count it measures). */
  tableRef: React.RefCallback<HTMLTableElement>
  isTabChartOpen: boolean
  // Drag-and-drop reorder
  dndSensors: SensorDescriptor<SensorOptions>[]
  handleDragEnd: (event: DragEndEvent) => void
  visibleEventIds: string[]
  /** Rows are in catalog order, so a drag has a meaning (see EventsPage). */
  canReorder: boolean
  // Header
  allVisibleSelected: boolean
  someVisibleSelected: boolean
  toggleAllVisibleSelected: (checked: boolean) => void
  activeEt: EventType | null
  hideStatus: boolean
  hideReviewed: boolean
  hideMonitor: boolean
  hideOwner: boolean
  hideDelta: boolean
  usersById: Map<string, { name: string | null; email: string }>
  hideTags: boolean
  hideLastSeen: boolean
  allTags: string[]
  filterTag: string
  setFilterTag: (value: string) => void
  visibleFieldColumns: FieldDefinition[]
  fieldFilters: Record<string, string>
  updateFieldFilter: (name: string, value: string) => void
  fieldEnumOptions: Record<string, Set<string>>
  visibleMetaFields: MetaFieldDefinition[]
  metaFilters: Record<string, string>
  updateMetaFilter: (name: string, value: string) => void
  // Body / virtualization
  events: EventListItem[]
  total: number
  /** Rows loaded from the server, before any client-side column filter. */
  loadedCount: number
  /** A field/meta column filter is narrowing the loaded rows client-side. */
  isClientFiltered: boolean
  /** The column filter is still paging through the rest of the catalog. */
  isScanningForMatches: boolean
  /** The list query has not produced a page for this view yet. */
  isLoading: boolean
  virtualize: boolean
  virtualItems: VirtualItem[]
  /** Zero-based first/last row index inside the viewport, when virtualized. */
  visibleRange: { first: number; last: number } | null
  totalVirtualSize: number
  measureRow: (el: Element | null) => void
  colCount: number
  expandedCell: string | null
  eventWindowMetricsByEvent: Map<string, EventWindowMetrics>
  eventRowSignals: Map<string, MonitoringSignal>
  metaValuesByEvent: Map<string, Map<string, string[]>>
  eventTypesById: Map<string, EventTypeBrief>
  slug: string
  selectedSet: Set<string>
  getFieldValue: (ev: EventListItem, col: FieldDefinition) => string
  getFieldValueRow: (ev: EventListItem, col: FieldDefinition) => EventFieldValue | undefined
  toggleEventSelected: (id: string, checked: boolean) => void
  onToggleExpandedCell: (cellKey: string | null) => void
  onRowAction: (action: RowAction, ev: EventListItem) => void
  /**
   * What produced the current (possibly empty) result, so a zero-row table can
   * say why it is empty instead of always claiming the project has no events
   * (tripl-jfm3.30).
   */
  emptyContext?: EventsEmptyContext
  /** Offered on a first-run empty state; omitted for a viewer. */
  onNewEvent?: () => void
  /** Adds ids to the selection in one update (a name cluster's "Select"). */
  selectMany: (ids: string[]) => void
}

export function EventsTable({
  tableScrollRef,
  tableRef,
  isTabChartOpen,
  dndSensors,
  handleDragEnd,
  visibleEventIds,
  canReorder,
  allVisibleSelected,
  someVisibleSelected,
  toggleAllVisibleSelected,
  activeEt,
  hideStatus,
  hideReviewed,
  hideMonitor,
  hideOwner,
  hideDelta,
  usersById,
  hideTags,
  hideLastSeen,
  allTags,
  filterTag,
  setFilterTag,
  visibleFieldColumns,
  fieldFilters,
  updateFieldFilter,
  fieldEnumOptions,
  visibleMetaFields,
  metaFilters,
  updateMetaFilter,
  events,
  total,
  loadedCount,
  isClientFiltered,
  isScanningForMatches,
  isLoading,
  virtualize,
  virtualItems,
  visibleRange,
  totalVirtualSize,
  measureRow,
  colCount,
  expandedCell,
  eventWindowMetricsByEvent,
  eventRowSignals,
  metaValuesByEvent,
  eventTypesById,
  slug,
  selectedSet,
  getFieldValue,
  getFieldValueRow,
  toggleEventSelected,
  onToggleExpandedCell,
  onRowAction,
  emptyContext,
  onNewEvent,
  selectMany,
}: EventsTableProps) {
  const branchId = useActiveBranchId()
  // Selecting is only ever for a bulk edit, which a viewer cannot make.
  const canWrite = useCanWriteProject()
  const emptyCopy = eventsEmptyCopy(
    emptyContext ?? { activeTab: 'all', hasActiveFilters: false, search: '' },
  )
  // Shared with EventEditPage and useEventsPageData — one fetch powers
  // unknown-token tinting across every row. NOT shared with the Variables
  // settings tab: that one needs `total` and so caches the page envelope under
  // variablesPageKey. They used to share this key, which handed these rows an
  // object instead of an array and crashed the page (tripl-lqxb).
  const { data: projectVariables } = useQuery({
    queryKey: variablesKey(slug, branchId),
    queryFn: () => variablesApi.list(slug, branchId),
  })

  // Cluster near-identical, scan-generated names so a block of look-alike rows
  // can be triaged as one. This is a read-only summary computed from the loaded
  // rows — it never reorders or replaces the flat/virtualized list below.
  const [clustersExpanded, setClustersExpanded] = useState(false)
  const nameClusters = useMemo(
    () =>
      groupEventNames(
        // `events` can be sparse while paginated rows stream in; drop the holes.
        events.filter((ev): ev is EventListItem => Boolean(ev)),
        TABLE_CLUSTER_MIN_SIZE,
      ).groups.filter(group => isDeepPrefix(group.prefix)),
    [events],
  )
  const selectCluster = (group: EventNameGroup) => selectMany(group.eventIds)
  // Clusters come from the loaded pages, so their counts grow as more load.
  const clustersArePartial = loadedCount < total

  // Visible window for the "Showing X–Y" footer: the rows inside the viewport
  // when virtualized, every loaded row otherwise.
  const firstVisible = visibleRange ? visibleRange.first + 1 : events.length > 0 ? 1 : 0
  const lastVisible = visibleRange ? visibleRange.last + 1 : events.length
  const rangeLabel =
    firstVisible === lastVisible
      ? firstVisible.toLocaleString()
      : `${firstVisible.toLocaleString()}–${lastVisible.toLocaleString()}`
  // What the footer says. Under a column filter the server total is not the
  // number of matches, so it reports the matches among the rows checked so far
  // instead of "Showing 1–40 of 5,000" (EVT-16).
  const footerLabel = isClientFiltered
    ? `${events.length.toLocaleString()} matching · ${loadedCount.toLocaleString()} of ${total.toLocaleString()} checked`
    : `Showing ${rangeLabel} of ${total.toLocaleString()} events`

  const renderEventRow = (ev: EventListItem, virtualIndex?: number) => {
    const expandedFieldId =
      expandedCell && expandedCell.startsWith(ev.id + '-')
        ? expandedCell.slice(ev.id.length + 1)
        : null
    const windowMetric = eventWindowMetricsByEvent.get(ev.id)
    const windowData = windowMetric?.data ?? EMPTY_WINDOW_POINTS
    // Distinguish a genuine zero from "not wired": page-view types return a
    // real series, so a sum of 0 is a true zero (flat sparkline + "0").
    // Structured/user types with no collected series have an empty `data`
    // array — passing `undefined` makes the cell read as no-data ("—") instead
    // of a misleading bare "0".
    const windowTotal =
      windowData.length > 0 ? windowMetric?.total_count : undefined
    return (
      <EventRow
        key={ev.id}
        ev={ev}
        selected={selectedSet.has(ev.id)}
        hideType={!!activeEt}
        hideStatus={hideStatus}
        hideReviewed={hideReviewed}
        hideMonitor={hideMonitor}
        hideOwner={hideOwner}
        hideDelta={hideDelta}
        usersById={usersById}
        hideTags={hideTags}
        hideLastSeen={hideLastSeen}
        fieldColumns={visibleFieldColumns}
        metaFields={visibleMetaFields}
        variables={projectVariables}
        slug={slug}
        expandedFieldId={expandedFieldId}
        rowSignal={eventRowSignals.get(ev.id)}
        windowTotal={windowTotal}
        windowData={windowData}
        metaValueMap={metaValuesByEvent.get(ev.id)}
        eventType={eventTypesById.get(ev.event_type_id)}
        getFieldValue={getFieldValue}
        getFieldValueRow={getFieldValueRow}
        onToggleSelected={toggleEventSelected}
        onToggleExpanded={onToggleExpandedCell}
        onRowAction={onRowAction}
        reorderable={canReorder}
        measureRef={virtualize ? measureRow : undefined}
        virtualIndex={virtualIndex}
      />
    )
  }

  // Spacer rows stand in for the virtualized rows above and below the window.
  const firstVirtual = virtualItems[0]
  const lastVirtual = virtualItems[virtualItems.length - 1]

  return (
    // A short delay: at 0 every 48h cell the pointer crossed mounted its lazy
    // chart on the way past (EVT-46).
    <TooltipProvider delayDuration={300}>
      <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext
          items={visibleEventIds}
          strategy={verticalListSortingStrategy}
          disabled={!canReorder}
        >
          {nameClusters.length > 0 && (
            <div
              className="border-b text-[11px]"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--bg-sunken)',
                color: 'var(--fg-subtle)',
              }}
            >
              <button
                type="button"
                onClick={() => setClustersExpanded((open) => !open)}
                aria-expanded={clustersExpanded}
                className="flex w-full items-center gap-1.5 px-5 py-2 text-left hover:text-foreground"
              >
                {clustersExpanded ? (
                  <ChevronDown className="size-3.5" aria-hidden />
                ) : (
                  <ChevronRight className="size-3.5" aria-hidden />
                )}
                <Layers className="size-3.5" aria-hidden />
                <span>
                  <span className="mono tnum" style={{ color: 'var(--fg-muted)' }}>
                    {nameClusters.length.toLocaleString()}
                  </span>{' '}
                  similar-name {nameClusters.length === 1 ? 'cluster' : 'clusters'} detected
                  {clustersArePartial && ' among loaded rows'}
                </span>
              </button>
              {clustersExpanded && (
                <ul className="pb-1.5">
                  {nameClusters.slice(0, MAX_VISIBLE_CLUSTERS).map((group) => (
                    <li key={group.prefix} className="flex items-center gap-2 px-5 py-1">
                      <span
                        className="mono truncate"
                        style={{ color: 'var(--fg-muted)' }}
                        title={group.prefix}
                      >
                        {group.prefix}
                        <span style={{ color: 'var(--fg-faint)' }}>…</span>
                      </span>
                      <span className="mono tnum whitespace-nowrap">
                        · {group.count.toLocaleString()} events
                      </span>
                      <div className="flex-1" />
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => selectCluster(group)}
                        aria-label={`Select all ${group.count} events in cluster ${group.prefix}`}
                      >
                        Select
                      </Button>
                    </li>
                  ))}
                  {nameClusters.length > MAX_VISIBLE_CLUSTERS && (
                    <li className="px-5 py-1" style={{ color: 'var(--fg-faint)' }}>
                      and {(nameClusters.length - MAX_VISIBLE_CLUSTERS).toLocaleString()} more…
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}
          <div
            ref={tableScrollRef}
            className="tripl-table-wrap"
            style={{
              maxHeight: isTabChartOpen
                ? 'max(320px, calc(100vh - 455px))'
                : 'max(420px, calc(100vh - 285px))',
              overflowY: 'auto',
            }}
          >
            <Table
              ref={tableRef}
              // A card per row below md (eventsPhoneCard.ts).
              className={`tripl-table ${PHONE_TABLE}`}
              aria-label={activeEt ? `${activeEt.display_name} events` : 'Events'}
            >
              <TableHeader>
                <TableRow className={PHONE_HEADER_ROW}>
                  <TableHead className="w-8 px-1" aria-label="Reorder" />
                  <TableHead className="tripl-pin-l w-10 pl-5">
                    {canWrite && (
                      <Checkbox
                        checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                        onCheckedChange={(checked) => toggleAllVisibleSelected(checked === true)}
                        aria-label="Select all visible events"
                      />
                    )}
                  </TableHead>
                  {/* Pinned left with the checkbox: 8 of 17 columns sit
                      off-screen at 1512px, so without this the reader scrolls
                      to PAGE/CATEGORY/ACTION with no way to see which event the
                      row belongs to (tripl-1uls). `data-pinned` also tells the
                      overflow measurement which column never leaves. */}
                  <TableHead
                    data-pinned="true"
                    className="tripl-pin-l border-r"
                    style={{ ...PINNED_EVENT_CELL_STYLE, borderColor: 'var(--border)' }}
                  >
                    Event
                  </TableHead>
                  {!activeEt && <TableHead>Type</TableHead>}
                  {!hideStatus && <TableHead>Status</TableHead>}
                  {!hideReviewed && (
                    <TableHead className="w-20 text-center text-[11px]">Reviewed</TableHead>
                  )}
                  {/* "Signal", not "Monitor": these cells report the anomaly
                      tripl detected on the row, which needs no monitor to
                      exist. Heading them "Monitor" put "Firing" beside 30
                      events on a project whose Monitors page correctly said
                      "No monitors yet" (tripl-jfm3.4). */}
                  {!hideMonitor && (
                    <TableHead
                      className="w-24"
                      title="Open signal on this event — a spike or drop tripl detected in its volume"
                    >
                      Signal
                    </TableHead>
                  )}
                  {!hideDelta && (
                    <TableHead
                      className="w-20 text-right text-[11px]"
                      title={DELTA_HEAD_HELP}
                    >
                      Δ · 24h
                    </TableHead>
                  )}
                  <TableHead
                    className="w-32 text-right"
                    title={`Event volume over the last ${ROW_METRICS_LABEL} (rolling 48 hours), with sparkline`}
                  >
                    {ROW_METRICS_LABEL}
                  </TableHead>
                  {!hideTags && (
                    <FilterableHead
                      label="Tags"
                      filter={
                        allTags.length > 0 ? (
                          <ColumnFilter
                            label="Tag"
                            type="enum"
                            value={filterTag}
                            options={allTags}
                            onChange={setFilterTag}
                          />
                        ) : null
                      }
                    />
                  )}
                  {!hideLastSeen && (
                    <TableHead className="w-24 text-[11px]">Last seen</TableHead>
                  )}
                  {!hideOwner && <TableHead className="w-28 text-[11px]">Owner</TableHead>}
                  {visibleFieldColumns.map((f) => {
                    const enumOpts = fieldEnumOptions[f.id]
                    const filterType: ColumnFilterType | null =
                      f.field_type === 'enum' && enumOpts
                        ? 'enum'
                        : f.field_type === 'boolean'
                          ? 'boolean'
                          : f.field_type === 'json'
                            ? null
                            : 'text'
                    return (
                      <FilterableHead
                        key={f.id}
                        label={f.display_name}
                        filter={
                          filterType ? (
                            <ColumnFilter
                              label={f.display_name}
                              type={filterType}
                              value={fieldFilters[f.name] ?? ''}
                              options={
                                filterType === 'enum'
                                  ? Array.from(enumOpts ?? [])
                                  : undefined
                              }
                              onChange={(v) => updateFieldFilter(f.name, v)}
                            />
                          ) : null
                        }
                      />
                    )
                  })}
                  {visibleMetaFields.map((mf) => {
                    const filterType: ColumnFilterType =
                      mf.field_type === 'enum' && mf.enum_options
                        ? 'enum'
                        : mf.field_type === 'boolean'
                          ? 'boolean'
                          : 'text'
                    return (
                      <FilterableHead
                        key={mf.id}
                        label={mf.display_name}
                        className="text-muted-foreground"
                        filter={
                          <ColumnFilter
                            label={mf.display_name}
                            type={filterType}
                            value={metaFilters[mf.name] ?? ''}
                            options={
                              filterType === 'enum'
                                ? mf.enum_options ?? undefined
                                : undefined
                            }
                            onChange={(v) => updateMetaFilter(mf.name, v)}
                          />
                        }
                      />
                    )
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {virtualize && firstVirtual && firstVirtual.start > 0 && (
                  <tr aria-hidden style={{ height: firstVirtual.start }}>
                    <td colSpan={colCount} />
                  </tr>
                )}
                {virtualize
                  ? virtualItems.map((vi) => {
                      const ev = events[vi.index]
                      // The spacer is sized to the full plan total so the
                      // scrollbar maps linearly, but rows are paginated — an
                      // index whose page has not streamed in yet renders as a
                      // height-preserving placeholder so the scroll height
                      // stays exact until the row's data arrives.
                      if (!ev) {
                        return (
                          <tr key={vi.key} aria-hidden style={{ height: vi.size }}>
                            <td colSpan={colCount} />
                          </tr>
                        )
                      }
                      return renderEventRow(ev, vi.index)
                    })
                  : events.map((ev) => renderEventRow(ev))}
                {virtualize &&
                  lastVirtual &&
                  totalVirtualSize > lastVirtual.end && (
                    <tr
                      aria-hidden
                      style={{
                        height: totalVirtualSize - lastVirtual.end,
                      }}
                    >
                      <td colSpan={colCount} />
                    </tr>
                  )}
                {events.length === 0 && (
                  <TableRow className={PHONE_FULL_ROW}>
                    <TableCell colSpan={99}>
                      {isLoading || isScanningForMatches ? (
                        // Not the empty state: during the cold load it
                        // flashed "No events yet — create your first event"
                        // on every visit (EVT-14), and a column filter with no
                        // match on the first page is still searching the rest
                        // (EVT-4).
                        <div
                          role="status"
                          className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
                        >
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          {isLoading
                            ? 'Loading events…'
                            : `Searching… ${loadedCount.toLocaleString()} of ${total.toLocaleString()} events checked`}
                        </div>
                      ) : (
                        <EmptyState
                          icon={emptyCopy.isFirstRun ? ListPlus : Inbox}
                          title={emptyCopy.title}
                          description={emptyCopy.description}
                          action={
                            emptyCopy.isFirstRun && onNewEvent ? (
                              <Button size="sm" onClick={onNewEvent}>
                                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                                New event
                              </Button>
                            ) : undefined
                          }
                        />
                      )}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {events.length > 0 && (
            <div
              className="flex h-[30px] items-center gap-3.5 border-t px-5 text-[11px]"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--bg-sunken)',
                color: 'var(--fg-subtle)',
              }}
            >
              <span aria-live="polite" aria-atomic="true" className="sr-only">
                {footerLabel}
              </span>
              <span aria-hidden="true" className="mono tnum">
                {footerLabel}
              </span>
              {isScanningForMatches && (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  searching the rest…
                </span>
              )}
              <div className="flex-1" />
              {virtualize && (
                <span className="inline-flex items-center gap-1.5">
                  <Dot tone="accent" size={5} pulse />
                  virtualized · row {firstVisible.toLocaleString()}
                </span>
              )}
            </div>
          )}
        </SortableContext>
      </DndContext>
    </TooltipProvider>
  )
}
