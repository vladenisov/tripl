import { memo } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { EventListItem } from '@/types'
import {
  EVENT_STATUS_DOT_TONE,
  EVENT_STATUS_LABELS,
  EVENT_STATUS_TONE,
  EVENT_STATUSES,
  type EventStatus,
} from '@/lib/eventStatus'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Hover-only row action cluster for the events table.
 *
 * Rendered as an absolute overlay that floats over the hovered row's trailing
 * cell with a left→right gradient. The trailing `<td>` itself stays a fixed
 * narrow width for *every* row, so revealing this cluster on hover never
 * reserves or reclaims horizontal space on the other rows.
 *
 * Only the in-table actions live here: move up, move down, and a status select
 * (all 7 statuses). Edit / metrics / archive / delete live on the event detail
 * page, not on the row.
 */
export const EventRowActions = memo(function EventRowActions({
  event,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onSetStatus,
}: {
  event: EventListItem
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onSetStatus?: (status: EventStatus) => void
}) {
  return (
    <div
      className="tripl-row-actions pointer-events-none absolute inset-y-0 right-0 z-30 hidden items-center gap-1 pl-10 pr-3 group-hover/row:flex focus-within:flex"
      style={{
        background:
          'linear-gradient(to right, transparent, var(--surface-hover) 28px, var(--surface-hover))',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded border bg-[var(--bg-elevated)] text-[var(--fg-subtle)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--fg)] disabled:cursor-not-allowed disabled:opacity-40"
        style={{ borderColor: 'var(--border)' }}
        aria-label="Move event up"
        onClick={onMoveUp}
        disabled={!canMoveUp}
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded border bg-[var(--bg-elevated)] text-[var(--fg-subtle)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--fg)] disabled:cursor-not-allowed disabled:opacity-40"
        style={{ borderColor: 'var(--border)' }}
        aria-label="Move event down"
        onClick={onMoveDown}
        disabled={!canMoveDown}
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </button>
      {onSetStatus && (
        <div className="pointer-events-auto">
          <Select
            value={event.status}
            onValueChange={(v) => onSetStatus?.(v as EventStatus)}
          >
            <SelectTrigger className="h-6 w-auto gap-1 px-2 text-[11px]" aria-label="Set event status">
              <SelectValue>
                <Chip tone={EVENT_STATUS_TONE[event.status as EventStatus]} size="xs">
                  {EVENT_STATUS_LABELS[event.status as EventStatus] ?? event.status}
                </Chip>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {EVENT_STATUSES.map((s) => (
                <SelectItem key={s} value={s} className="text-[11px]">
                  <Dot tone={EVENT_STATUS_DOT_TONE[s]} size={6} />
                  {EVENT_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
})
