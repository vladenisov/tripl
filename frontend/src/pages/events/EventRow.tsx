import { Fragment, memo } from 'react'
import type { ReactNode } from 'react'
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
  Variable,
} from '@/types'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { TableCell, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { EVENT_STATUS_DOT_TONE, EVENT_STATUS_LABELS } from '@/lib/eventStatus'
import type { EventStatus } from '@/lib/eventStatus'
import { SIGNAL_LEVEL, rowSignalLevel } from '@/lib/statusLexicon'
import { resolveMetaFieldHref } from '@/lib/metaFields'
import { VariableValueContextTrigger } from '@/components/variable-value-contexts'
import { EventName } from '@/components/event-name'
import { EventDriftBadge } from './EventDriftBadge'
import { EventWindowMetricsCell } from './EventWindowMetricsCell'
import { computeWindowDelta, formatRelativeTime, splitTemplateValue } from './utils'

export type RowAction =
  | 'edit'
  | 'navigate-monitoring'
  | 'move-up'
  | 'move-down'
  | 'set-status-archived'
  | 'set-status-draft'
  | 'delete'

function renderTemplateValue(value: string, variables?: Variable[]): ReactNode {
  const parts = splitTemplateValue(value, variables)
  if (parts.length === 1 && !parts[0].token) return value
  return parts.map((part, i) =>
    part.token ? (
      part.known === false ? (
        // Amber = the ${token} resolves to no variable (name, source_name or
        // binding) — it will never receive observed values.
        <span key={i} className="mono text-amber-600" title="Unknown variable token">
          {part.text}
        </span>
      ) : (
        <span key={i} className="mono" style={{ color: 'var(--accent)' }}>
          {part.text}
        </span>
      )
    ) : (
      <Fragment key={i}>{part.text}</Fragment>
    ),
  )
}

// A muted em-dash placeholder for a cell with no value. The `title` keeps the
// bare "—" from reading as broken and lets it be told apart from a real 0.
function NoData({ title, className }: { title: string; className?: string }): ReactNode {
  return (
    <span className={className ?? 'text-[11px]'} style={{ color: 'var(--fg-faint)' }} title={title}>
      —
    </span>
  )
}

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
  variables?: Variable[]
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
  variables,
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
  // One incident, one saturated indicator: the Monitor-cell signal chip is the
  // single act-on-me affordance. The name-cell dot stays on the (orthogonal)
  // lifecycle status, the SignalLink arrow is dropped, and the volume sparkline
  // is neutralised when a signal is live — so a single anomaly no longer reads
  // as four stacked red marks across the row.
  const signalLevel = rowSignal ? rowSignalLevel(rowSignal.state) : null
  const historicalAnomalyIdx = windowData.findIndex((p) => p.is_anomaly)
  // Suppress the red sparkline dot while a signal is live (the chip already
  // carries it); keep it for rows whose only cue is a past-window anomaly.
  const sparklineAnomalyIdx = rowSignal
    ? null
    : historicalAnomalyIdx >= 0
      ? historicalAnomalyIdx
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
          className="flex h-6 w-6 cursor-grab touch-none items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100 active:cursor-grabbing"
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
          <Dot tone={statusTone} pulse={false} size={6} />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="mono truncate text-left text-[12.5px] hover:underline underline-offset-4"
                onClick={() => onRowAction('navigate-monitoring', ev)}
                // Native title only when there's no description to show in the
                // richer tooltip — avoids a double (native + Radix) popover.
                title={ev.description ? undefined : ev.name}
              >
                <EventName name={ev.name} />
              </button>
            </TooltipTrigger>
            {ev.description && (
              <TooltipContent side="bottom" align="start" className="max-w-xs whitespace-normal">
                {ev.description}
              </TooltipContent>
            )}
          </Tooltip>
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
            <span
              aria-hidden="true"
              className="text-[11px]"
              style={{ color: 'var(--fg-faint)' }}
              title="Not reviewed"
            >
              —
            </span>
          )}
        </TableCell>
      )}
      {!hideMonitor && (
        <TableCell>
          {rowSignal ? (
            <Chip tone={signalLevel?.tone ?? 'danger'} size="xs">
              {signalLevel?.label ?? SIGNAL_LEVEL.firing.label}
            </Chip>
          ) : ev.monitored ? (
            <Chip tone="neutral" variant="outline" size="xs" title="Covered by an alert rule">
              Monitored
            </Chip>
          ) : (
            <NoData title="Not covered by any alert rule" />
          )}
        </TableCell>
      )}
      {!hideDelta && (
        <TableCell className="tnum text-right text-[11px]">
          {(() => {
            const pct = computeWindowDelta(windowData)
            if (pct == null) {
              return <NoData title="No prior 24h window to compare against" />
            }
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
        <div className="flex items-center justify-end align-middle">
          <EventWindowMetricsCell
            eventName={ev.name}
            color={eventType?.color ?? 'var(--accent)'}
            totalCount={windowTotal}
            data={windowData}
            anomalyIdx={sparklineAnomalyIdx}
            signalTone={null}
          />
        </div>
      </TableCell>
      {!hideTags && (
        <TableCell>
          <div className="flex flex-wrap gap-1">
            {ev.tags.map((t) => (
              <Chip key={t.id} size="xs">{t.name}</Chip>
            ))}
            {ev.tags.length === 0 && <NoData title="No tags" />}
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
              <NoData title="No owner" />
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
                  <pre className="max-w-sm whitespace-pre-wrap break-all font-mono text-[11px]">{renderTemplateValue((() => {
                    try { return JSON.stringify(JSON.parse(val), null, 2) } catch { return val }
                  })(), variables)}</pre>
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
                  {renderTemplateValue(val, variables)}
                </button>
                <VariableValueContextTrigger contexts={fieldValue?.variable_values} />
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5">
                {val === '' ? (
                  <NoData title="No data" className="min-w-0 text-[11px]" />
                ) : (
                  <span
                    className="min-w-0"
                    style={val === '0' ? { color: 'var(--fg-faint)' } : undefined}
                  >
                    {renderTemplateValue(val, variables)}
                  </span>
                )}
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
            ) : mv === '' ? (
              <NoData title="No data" />
            ) : (
              mv
            )}
          </TableCell>
        )
      })}
    </TableRow>
  )
})
