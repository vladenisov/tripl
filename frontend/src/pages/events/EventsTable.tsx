import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Calendar, ChevronDown, ChevronRight, Layers } from 'lucide-react'
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
  EventListItem,
  EventType,
  EventTypeBrief,
  EventWindowMetrics,
  FieldDefinition,
  MetaFieldDefinition,
  MonitoringSignal,
} from '@/types'

import { ColumnFilter, FilterableHead, type ColumnFilterType } from './ColumnFilter'
import { EventRow, type RowAction } from './EventRow'
import { groupEventNames, type EventNameGroup } from './eventNameGroups'
import { EMPTY_WINDOW_POINTS, ROW_METRICS_LABEL } from './utils'

/** Cap the cluster list so the summary header stays compact; the rest fold into a count. */
const MAX_VISIBLE_CLUSTERS = 6

export type EventsTableProps = {
  // Layout
  tableScrollRef: React.RefObject<HTMLDivElement | null>
  isTabChartOpen: boolean
  // Drag-and-drop reorder
  dndSensors: SensorDescriptor<SensorOptions>[]
  handleDragEnd: (event: DragEndEvent) => void
  visibleEventIds: string[]
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
  virtualize: boolean
  virtualItems: VirtualItem[]
  totalVirtualSize: number
  colCount: number
  expandedCell: string | null
  eventWindowMetricsByEvent: Map<string, EventWindowMetrics>
  eventRowSignals: Map<string, MonitoringSignal>
  metaValuesByEvent: Map<string, Map<string, string>>
  eventTypesById: Map<string, EventTypeBrief>
  slug: string
  selectedSet: Set<string>
  getFieldValue: (ev: EventListItem, col: FieldDefinition) => string
  toggleEventSelected: (id: string, checked: boolean) => void
  onToggleExpandedCell: (cellKey: string | null) => void
  onRowAction: (action: RowAction, ev: EventListItem) => void
}

export function EventsTable({
  tableScrollRef,
  isTabChartOpen,
  dndSensors,
  handleDragEnd,
  visibleEventIds,
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
  virtualize,
  virtualItems,
  totalVirtualSize,
  colCount,
  expandedCell,
  eventWindowMetricsByEvent,
  eventRowSignals,
  metaValuesByEvent,
  eventTypesById,
  slug,
  selectedSet,
  getFieldValue,
  toggleEventSelected,
  onToggleExpandedCell,
  onRowAction,
}: EventsTableProps) {
  const branchId = useActiveBranchId()
  // Same cache key as the Variables settings page/EventEditPage — one fetch
  // powers unknown-token tinting across every row.
  const { data: projectVariables } = useQuery({
    queryKey: ['variables', slug, branchId],
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
      ).groups,
    [events],
  )
  const selectCluster = (group: EventNameGroup) => {
    for (const id of group.eventIds) toggleEventSelected(id, true)
  }

  // Visible window for the "Showing X–Y of N" footer. When virtualized this
  // tracks the rendered window as the user scrolls; otherwise all loaded rows
  // are on screen.
  const firstVisible =
    virtualize && virtualItems.length > 0
      ? virtualItems[0].index + 1
      : events.length > 0
        ? 1
        : 0
  const lastVisible =
    virtualize && virtualItems.length > 0
      ? virtualItems[virtualItems.length - 1].index + 1
      : events.length
  const rangeLabel =
    firstVisible === lastVisible
      ? firstVisible.toLocaleString()
      : `${firstVisible.toLocaleString()}–${lastVisible.toLocaleString()}`

  const renderEventRow = (ev: EventListItem) => {
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
        onToggleSelected={toggleEventSelected}
        onToggleExpanded={onToggleExpandedCell}
        onRowAction={onRowAction}
      />
    )
  }

  return (
    <TooltipProvider delayDuration={0}>
      <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={visibleEventIds} strategy={verticalListSortingStrategy}>
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
              className="tripl-table"
              aria-label={activeEt ? `${activeEt.display_name} events` : 'Events'}
            >
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8 px-1" aria-label="Reorder" />
                  <TableHead className="tripl-pin-l w-10 pl-5">
                    <Checkbox
                      checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                      onCheckedChange={(checked) => toggleAllVisibleSelected(checked === true)}
                      aria-label="Select all visible events"
                    />
                  </TableHead>
                  <TableHead
                    className="border-r"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    Event
                  </TableHead>
                  {!activeEt && <TableHead>Type</TableHead>}
                  {!hideStatus && <TableHead>Status</TableHead>}
                  {!hideReviewed && (
                    <TableHead className="w-20 text-center text-[11px]">Reviewed</TableHead>
                  )}
                  {!hideMonitor && <TableHead className="w-24">Monitor</TableHead>}
                  {!hideDelta && (
                    <TableHead
                      className="w-20 text-right text-[11px]"
                      title="Δ · 24h — change in volume versus the previous 24-hour window"
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
                {virtualize && virtualItems.length > 0 && virtualItems[0].start > 0 && (
                  <tr aria-hidden style={{ height: virtualItems[0].start }}>
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
                      return renderEventRow(ev)
                    })
                  : events.map((ev) => renderEventRow(ev))}
                {virtualize &&
                  virtualItems.length > 0 &&
                  totalVirtualSize > virtualItems[virtualItems.length - 1].end && (
                    <tr
                      aria-hidden
                      style={{
                        height: totalVirtualSize - virtualItems[virtualItems.length - 1].end,
                      }}
                    >
                      <td colSpan={colCount} />
                    </tr>
                  )}
                {events.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={99}>
                      <EmptyState
                        icon={Calendar}
                        title="No events yet"
                        description="Create your first event to get started."
                      />
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
                Showing {rangeLabel} of {total.toLocaleString()} events
              </span>
              <span>
                Showing{' '}
                <span className="mono tnum" style={{ color: 'var(--fg-muted)' }}>
                  {rangeLabel}
                </span>{' '}
                of{' '}
                <span className="mono tnum" style={{ color: 'var(--fg)' }}>
                  {total.toLocaleString()}
                </span>
              </span>
              <span style={{ color: 'var(--fg-faint)' }}>·</span>
              <span className="mono tnum">{total.toLocaleString()} total in plan</span>
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
