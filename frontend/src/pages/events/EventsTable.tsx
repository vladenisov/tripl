import { Calendar } from 'lucide-react'
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
import { EMPTY_WINDOW_POINTS, ROW_METRICS_LABEL } from './utils'

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

  return (
    <TooltipProvider delayDuration={0}>
      <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={visibleEventIds} strategy={verticalListSortingStrategy}>
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
            <Table className="tripl-table">
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
                    <TableHead className="w-20 text-right text-[11px]">Δ · 24h</TableHead>
                  )}
                  <TableHead className="w-32 text-right">{ROW_METRICS_LABEL}</TableHead>
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
                {(virtualize ? virtualItems.map((vi) => events[vi.index]) : events).map(
                  (ev: EventListItem) => {
                    const expandedFieldId =
                      expandedCell && expandedCell.startsWith(ev.id + '-')
                        ? expandedCell.slice(ev.id.length + 1)
                        : null
                    const windowMetric = eventWindowMetricsByEvent.get(ev.id)
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
                        slug={slug}
                        expandedFieldId={expandedFieldId}
                        rowSignal={eventRowSignals.get(ev.id)}
                        windowTotal={windowMetric?.total_count}
                        windowData={windowMetric?.data ?? EMPTY_WINDOW_POINTS}
                        metaValueMap={metaValuesByEvent.get(ev.id)}
                        eventType={eventTypesById.get(ev.event_type_id)}
                        getFieldValue={getFieldValue}
                        onToggleSelected={toggleEventSelected}
                        onToggleExpanded={onToggleExpandedCell}
                        onRowAction={onRowAction}
                      />
                    )
                  },
                )}
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
