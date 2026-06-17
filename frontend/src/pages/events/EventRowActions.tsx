import { memo } from 'react'
import { ArrowDown, ArrowUp, ChevronDown } from 'lucide-react'
import type { EventListItem } from '@/types'
import { EVENT_STATUS_LABELS, EVENT_STATUSES, type EventStatus } from '@/lib/eventStatus'

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
        title="Move event up"
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
        title="Move event down"
        aria-label="Move event down"
        onClick={onMoveDown}
        disabled={!canMoveDown}
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </button>
      {onSetStatus && (
        <div className="pointer-events-auto relative">
          <select
            value={event.status}
            onChange={(e) => onSetStatus(e.target.value as EventStatus)}
            className="h-6 appearance-none rounded border bg-[var(--bg-elevated)] pl-2 pr-5 text-[11px] text-[var(--fg-muted)] focus:outline-none"
            style={{ borderColor: 'var(--border)' }}
            title="Set status"
            aria-label="Set event status"
          >
            {EVENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {EVENT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--fg-subtle)]"
          />
        </div>
      )}
    </div>
  )
})
