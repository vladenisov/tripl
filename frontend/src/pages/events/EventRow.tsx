import { memo } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import type {
  EventListItem,
  EventMetricPoint,
  EventTypeBrief,
  FieldDefinition,
  MetaFieldDefinition,
  MonitoringSignal,
} from '@/types'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { TableCell, TableRow } from '@/components/ui/table'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { resolveMetaFieldHref } from '@/lib/metaFields'
import { EventDriftBadge } from './EventDriftBadge'
import { EventRowActions } from './EventRowActions'
import { EventWindowMetricsCell } from './EventWindowMetricsCell'
import { SignalLink } from './SignalLink'
import { formatRelativeTime } from './utils'

export type RowAction =
  | 'edit'
  | 'navigate-monitoring'
  | 'move-up'
  | 'move-down'
  | 'toggle-reviewed'
  | 'toggle-implemented'
  | 'toggle-archived'
  | 'delete'

export type EventRowProps = {
  ev: EventListItem
  eventType: EventTypeBrief | undefined
  selected: boolean
  hideType: boolean
  hideTags: boolean
  hideLastSeen: boolean
  fieldColumns: FieldDefinition[]
  metaFields: MetaFieldDefinition[]
  slug: string
  canMoveUp: boolean
  canMoveDown: boolean
  expandedFieldId: string | null
  rowSignal: MonitoringSignal | undefined
  windowTotal: number | undefined
  windowData: EventMetricPoint[]
  metaValueMap: Map<string, string> | undefined
  getFieldValue: (ev: EventListItem, f: FieldDefinition) => string
  onToggleSelected: (id: string, checked: boolean) => void
  onToggleExpanded: (cellKey: string | null) => void
  onRowAction: (action: RowAction, ev: EventListItem) => void
}

export const EventRow = memo(function EventRow({
  ev,
  eventType,
  selected,
  hideType,
  hideTags,
  hideLastSeen,
  fieldColumns,
  metaFields,
  slug,
  canMoveUp,
  canMoveDown,
  expandedFieldId,
  rowSignal,
  windowTotal,
  windowData,
  metaValueMap,
  getFieldValue,
  onToggleSelected,
  onToggleExpanded,
  onRowAction,
}: EventRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: ev.id })
  const dragStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : undefined,
    position: 'relative',
    zIndex: isDragging ? 1 : undefined,
  }
  const anomalyIdx = windowData.findIndex((p) => p.is_anomaly)
  const signalTone: 'danger' | 'warning' | null = rowSignal
    ? rowSignal.state === 'latest_scan'
      ? 'danger'
      : 'warning'
    : null
  const statusTone: 'success' | 'warning' | 'neutral' = ev.archived
    ? 'neutral'
    : ev.implemented
      ? 'success'
      : ev.reviewed
        ? 'warning'
        : 'neutral'

  return (
    <TableRow ref={setNodeRef} style={dragStyle} data-state={selected ? 'selected' : undefined}>
      <TableCell className="w-8 px-1">
        <button
          type="button"
          className="flex h-6 w-6 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-muted active:cursor-grabbing"
          aria-label={`Drag to reorder ${ev.name}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      </TableCell>
      <TableCell className="tripl-pin-l pl-5">
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onToggleSelected(ev.id, checked === true)}
          aria-label={`Select ${ev.name}`}
        />
      </TableCell>
      <TableCell className="font-medium">
        <div className="inline-flex max-w-full items-center gap-2 align-middle">
          <Dot tone={signalTone ?? statusTone} pulse={!!signalTone} size={6} />
          <button
            className="mono truncate text-left text-[12.5px] hover:underline underline-offset-4"
            onClick={() => onRowAction('navigate-monitoring', ev)}
            title={ev.name}
          >
            {ev.name}
          </button>
          {ev.drift_count > 0 && (
            <EventDriftBadge slug={slug} eventTypeId={ev.event_type_id} count={ev.drift_count} />
          )}
        </div>
      </TableCell>
      {!hideType && (
        <TableCell>
          <Chip size="xs">
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: eventType?.color }}
            />
            {eventType?.name ?? ''}
          </Chip>
        </TableCell>
      )}
      <TableCell className="text-right">
        <div className="inline-flex items-center justify-end gap-2 align-middle">
          <SignalLink slug={slug} signal={rowSignal} compact />
          <EventWindowMetricsCell
            eventName={ev.name}
            color={eventType?.color ?? 'var(--accent)'}
            totalCount={windowTotal}
            data={windowData}
            anomalyIdx={anomalyIdx >= 0 ? anomalyIdx : null}
            signalTone={signalTone}
          />
        </div>
      </TableCell>
      {!hideTags && (
        <TableCell>
          <div className="flex flex-wrap gap-1">
            {ev.tags.map((t) => (
              <Chip key={t.id} size="xs">{t.name}</Chip>
            ))}
            {ev.tags.length === 0 && (
              <span className="text-[11px]" style={{ color: 'var(--fg-faint)' }}>—</span>
            )}
          </div>
        </TableCell>
      )}
      {!hideLastSeen && (
        <TableCell
          className="text-[11px] tnum"
          style={{ color: ev.last_seen_at ? 'var(--fg-subtle)' : 'var(--fg-faint)' }}
          title={ev.last_seen_at ?? 'Never observed in collected metrics'}
        >
          {formatRelativeTime(ev.last_seen_at)}
        </TableCell>
      )}
      {fieldColumns.map((f) => {
        let val = getFieldValue(ev, f)
        if (val && /^-?\d+\.0+$/.test(val)) val = String(parseInt(val, 10))
        const cellKey = `${ev.id}-${f.id}`
        const isExpanded = expandedFieldId === f.id
        const isLong = typeof val === 'string' && val.length > 30
        return (
          <TableCell
            key={f.id}
            className={`text-xs ${isLong ? 'cursor-pointer' : ''} ${isExpanded ? '' : 'max-w-40'}`}
            onClick={isLong ? () => onToggleExpanded(cellKey) : undefined}
          >
            {isExpanded ? (
              <pre className="whitespace-pre-wrap break-all font-mono text-[11px] max-w-sm">{(() => {
                try { return JSON.stringify(JSON.parse(val), null, 2) } catch { return val }
              })()}</pre>
            ) : (
              <span className={isLong ? 'block truncate' : ''}>{val}</span>
            )}
          </TableCell>
        )
      })}
      {metaFields.map((mf) => {
        const mvRaw = metaValueMap?.get(mf.id)
        const mv = mvRaw ?? ''
        const href = resolveMetaFieldHref(mf, mv)
        return (
          <TableCell key={mf.id} className="text-muted-foreground max-w-40 truncate text-xs">
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate text-primary underline-offset-4 hover:underline"
                title={mv}
              >
                {mv}
              </a>
            ) : mf.field_type === 'boolean' && mvRaw ? (
              <Badge variant={mvRaw === 'true' ? 'success' : 'secondary'} className="text-[10px]">
                {mvRaw === 'true' ? 'Yes' : 'No'}
              </Badge>
            ) : mv}
          </TableCell>
        )
      })}
      <TableCell className="sticky right-0 z-10 border-l bg-background/95 pl-3 pr-2 backdrop-blur-sm hover:z-40 focus-within:z-40">
        <EventRowActions
          event={ev}
          slug={slug}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
          onEdit={() => onRowAction('edit', ev)}
          onMoveUp={() => onRowAction('move-up', ev)}
          onMoveDown={() => onRowAction('move-down', ev)}
          onToggleReviewed={() => onRowAction('toggle-reviewed', ev)}
          onToggleImplemented={() => onRowAction('toggle-implemented', ev)}
          onToggleArchived={() => onRowAction('toggle-archived', ev)}
          onDelete={() => onRowAction('delete', ev)}
        />
      </TableCell>
    </TableRow>
  )
})
