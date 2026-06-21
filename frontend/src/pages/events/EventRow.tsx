import { memo } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, GripVertical } from 'lucide-react'
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
import { EVENT_STATUS_DOT_TONE, EVENT_STATUS_LABELS } from '@/lib/eventStatus'
import type { EventStatus } from '@/lib/eventStatus'
import { resolveMetaFieldHref } from '@/lib/metaFields'
import { VariableValueContextTrigger } from '@/components/variable-value-contexts'
import { EventDriftBadge } from './EventDriftBadge'
import { EventWindowMetricsCell } from './EventWindowMetricsCell'
import { SignalLink } from './SignalLink'
import { formatRelativeTime } from './utils'

export type RowAction =
  | 'edit'
  | 'navigate-monitoring'
  | 'move-up'
  | 'move-down'
  | 'set-status-archived'
  | 'set-status-draft'
  | 'delete'

export type EventRowProps = {
  ev: EventListItem
  eventType: EventTypeBrief | undefined
  selected: boolean
  hideType: boolean
  hideStatus: boolean
  hideReviewed: boolean
  hideMonitor: boolean
  hideOwner: boolean
  hideDelta: boolean
  usersById: Map<string, { name: string | null; email: string }>
  hideTags: boolean
  hideLastSeen: boolean
  fieldColumns: FieldDefinition[]
  metaFields: MetaFieldDefinition[]
  slug: string
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
  hideStatus,
  hideReviewed,
  hideMonitor,
  hideOwner,
  hideDelta,
  usersById,
  hideTags,
  hideLastSeen,
  fieldColumns,
  metaFields,
  slug,
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
  const statusTone = EVENT_STATUS_DOT_TONE[(ev.status as EventStatus) ?? 'draft'] ?? 'neutral'

  return (
    <TableRow
      ref={setNodeRef}
      style={dragStyle}
      data-state={selected ? 'selected' : undefined}
      className="group/row"
    >
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
      <TableCell className="tripl-pin-l w-10 pl-5">
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onToggleSelected(ev.id, checked === true)}
          aria-label={`Select ${ev.name}`}
        />
      </TableCell>
      <TableCell
        className="border-r font-medium"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div className="inline-flex max-w-full items-center gap-2 align-middle">
          <Dot tone={signalTone ?? statusTone} pulse={!!signalTone} size={6} />
          <button
            type="button"
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
      {!hideStatus && (
        <TableCell>
          <Chip tone={statusTone} size="xs">
            {EVENT_STATUS_LABELS[(ev.status as EventStatus) ?? 'draft'] ?? ev.status}
          </Chip>
        </TableCell>
      )}
      {!hideReviewed && (
        <TableCell className="text-center" aria-label={ev.reviewed ? 'Reviewed' : 'Not reviewed'}>
          {ev.reviewed ? (
            <Check
              className="mx-auto h-3.5 w-3.5"
              aria-hidden="true"
              style={{ color: 'var(--success)' }}
            />
          ) : (
            <span aria-hidden="true" className="text-[11px]" style={{ color: 'var(--fg-faint)' }}>—</span>
          )}
        </TableCell>
      )}
      {!hideMonitor && (
        <TableCell>
          {rowSignal ? (
            <Chip tone={signalTone ?? 'danger'} size="xs">
              {signalTone === 'warning' ? 'Warning' : 'Firing'}
            </Chip>
          ) : (
            <span className="text-[11px]" style={{ color: 'var(--fg-faint)' }}>—</span>
          )}
        </TableCell>
      )}
      {!hideDelta && (
        <TableCell className="tnum text-right text-[11px]">
          {(() => {
            const last = windowData[windowData.length - 1]
            if (!last || last.expected_count == null || last.expected_count === 0) {
              return <span style={{ color: 'var(--fg-faint)' }}>—</span>
            }
            const pct = ((last.count - last.expected_count) / last.expected_count) * 100
            const color =
              Math.abs(pct) < 1
                ? 'var(--fg-subtle)'
                : pct >= 0
                  ? 'var(--success)'
                  : 'var(--danger)'
            return (
              <span style={{ color }}>
                {pct >= 0 ? '+' : ''}
                {pct.toFixed(0)}%
              </span>
            )
          })()}
        </TableCell>
      )}
      <TableCell className="w-32 text-right">
        <div className="grid grid-cols-[14px_106px] items-center justify-end gap-2 align-middle">
          <span className="flex h-3.5 w-3.5 items-center justify-center">
            <SignalLink slug={slug} signal={rowSignal} compact />
          </span>
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
      {!hideOwner && (
        <TableCell className="text-[11px]">
          {(() => {
            const u = ev.owner_id ? usersById.get(ev.owner_id) : undefined
            return u ? (
              <span style={{ color: 'var(--fg-subtle)' }}>{u.name ?? u.email}</span>
            ) : (
              <span style={{ color: 'var(--fg-faint)' }}>—</span>
            )
          })()}
        </TableCell>
      )}
      {fieldColumns.map((f) => {
        const fieldValue = ev.field_values.find((fv) => fv.field_definition_id === f.id)
        const val = getFieldValue(ev, f)
        const cellKey = `${ev.id}-${f.id}`
        const isExpanded = expandedFieldId === f.id
        const isLong = typeof val === 'string' && val.length > 30
        return (
          <TableCell
            key={f.id}
            className={`text-xs ${isExpanded ? '' : 'max-w-40'}`}
          >
            {isExpanded ? (
              <div className="flex items-start gap-1.5">
                <button
                  type="button"
                  className="block min-w-0 text-left"
                  onClick={() => onToggleExpanded(cellKey)}
                  aria-expanded={true}
                  aria-label={`Collapse ${f.display_name}`}
                >
                  <pre className="max-w-sm whitespace-pre-wrap break-all font-mono text-[11px]">{(() => {
                    try { return JSON.stringify(JSON.parse(val), null, 2) } catch { return val }
                  })()}</pre>
                </button>
                <VariableValueContextTrigger contexts={fieldValue?.variable_values} />
              </div>
            ) : isLong ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  className="block min-w-0 truncate text-left"
                  onClick={() => onToggleExpanded(cellKey)}
                  aria-expanded={false}
                  aria-label={`Expand ${f.display_name}`}
                >
                  {val}
                </button>
                <VariableValueContextTrigger contexts={fieldValue?.variable_values} />
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0">{val}</span>
                <VariableValueContextTrigger contexts={fieldValue?.variable_values} />
              </span>
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
    </TableRow>
  )
})
