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
  visibleIndexById: Map<string, number>
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
  visibleIndexById,
  getFieldValue,
  toggleEventSelected,
  onToggleExpandedCell,
  onRowAction,
}: EventsTableProps) {
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
                  <TableHead>Event</TableHead>
                  {!activeEt && <TableHead>Type</TableHead>}
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
                  <TableHead className="sticky right-0 z-20 w-[7.5rem] border-l bg-background text-right">
                    Actions
                  </TableHead>
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
                    const idx = visibleIndexById.get(ev.id) ?? -1
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
                        hideTags={hideTags}
                        hideLastSeen={hideLastSeen}
                        fieldColumns={visibleFieldColumns}
                        metaFields={visibleMetaFields}
                        slug={slug}
                        canMoveUp={idx > 0}
                        canMoveDown={idx >= 0 && idx < visibleEventIds.length - 1}
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
        </SortableContext>
      </DndContext>
    </TooltipProvider>
  )
}
