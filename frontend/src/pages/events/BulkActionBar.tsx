import { CheckCheck, Trash2, X } from 'lucide-react'

import { EVENT_STATUS_LABELS, EVENT_STATUSES, type EventStatus } from '@/lib/eventStatus'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// A stand-in for "no owner" inside the picker. Radix treats an empty
// SelectItem value as "clear the selection" and throws on it, and this Select
// already uses `value=""` as its own placeholder state, so the null has to
// travel as a sentinel and be turned back into a null on the way out.
const UNASSIGN_VALUE = '__unassign__'

export function BulkActionBar({
  selectedCount,
  selectedVisibleCount,
  matchingTotal,
  onSelectAllMatching,
  isSelectingAll,
  isDeleting,
  isUpdating,
  onSetStatus,
  onMarkReviewed,
  onAssignOwner,
  owners,
  onDelete,
  onClear,
}: {
  selectedCount: number
  /**
   * How many of the selected events are among the rows currently loaded. The
   * selection deliberately keeps ids that are off-screen so "Select all N
   * matching" can sweep unloaded rows — but a hand-ticked selection orphaned by
   * a narrowing filter or a tab switch got the same silence, leaving the bar
   * reading "20 selected" over a table with nothing ticked and a total of 3
   * (tripl-4i49). Omit when the two cannot differ.
   */
  selectedVisibleCount?: number
  /**
   * Total events matching the current filters/tab (may exceed loaded rows).
   * `null` when the match count is not known — a client-side column filter
   * narrows rows the server total still counts — so the button offers "all
   * matching" without a number rather than print the wrong one (EVT-2).
   */
  matchingTotal?: number | null
  /** Select every matching event so one bulk action sweeps the whole queue. */
  onSelectAllMatching?: () => void
  isSelectingAll?: boolean
  isDeleting: boolean
  isUpdating: boolean
  onSetStatus: (status: EventStatus) => void
  onMarkReviewed: () => void
  /** `null` clears the owner across the selection — see `UNASSIGN_VALUE`. */
  onAssignOwner: (userId: string | null) => void
  owners: { id: string; name: string | null; email: string }[]
  onDelete: () => void
  onClear: () => void
}) {
  if (selectedCount === 0) return null
  const disabled = isDeleting || isUpdating || isSelectingAll
  // Offer to widen the selection to the whole matching set when more events
  // match the filter than are currently selected (bulk triage by prefix/tab).
  const canSelectAll =
    !!onSelectAllMatching &&
    matchingTotal !== undefined &&
    (matchingTotal === null || matchingTotal > selectedCount)
  return (
    // Wraps, and never wider than the viewport: on one line the bar was ~750px,
    // so at 375px both ends were cut off and Delete and Clear were unreachable
    // (EVT-5). The page reserves room under the table while it is open.
    <div
      className="fixed bottom-[18px] left-1/2 z-30 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2.5 rounded-[10px] border py-1.5 pl-3.5 pr-2"
      style={{
        background: 'var(--bg-elevated)',
        borderColor: 'var(--border-strong)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <span className="text-[12px]" style={{ color: 'var(--fg-muted)' }}>
        <span className="mono font-semibold" style={{ color: 'var(--fg)' }}>{selectedCount}</span> selected
      </span>
      {selectedVisibleCount !== undefined && selectedVisibleCount < selectedCount && (
        <span className="text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
          · <span className="mono">{selectedVisibleCount}</span> on screen
        </span>
      )}
      {canSelectAll && (
        <button
          type="button"
          onClick={onSelectAllMatching}
          disabled={disabled}
          className="text-[12px] font-medium underline-offset-2 hover:underline disabled:opacity-50"
          style={{ color: 'var(--accent)' }}
        >
          {isSelectingAll
            ? 'Selecting…'
            : matchingTotal === null
              ? 'Select all matching'
              : `Select all ${matchingTotal.toLocaleString()}`}
        </button>
      )}
      <div className="hidden h-5 w-px sm:block" style={{ background: 'var(--border)' }} />
      <Select
        value=""
        onValueChange={v => { if (v) onSetStatus(v as EventStatus) }}
        disabled={disabled}
      >
        <SelectTrigger className="h-7 w-auto min-w-[8rem] whitespace-nowrap border-[var(--border-strong)] text-xs data-[placeholder]:text-foreground [&_svg]:text-foreground/70" aria-label="Set status">
          <SelectValue placeholder="Set status…" />
        </SelectTrigger>
        <SelectContent>
          {EVENT_STATUSES.map(s => (
            <SelectItem key={s} value={s} className="text-xs">
              {EVENT_STATUS_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        onClick={onMarkReviewed}
        disabled={disabled}
      >
        <CheckCheck className="mr-1 h-3.5 w-3.5" />
        Mark reviewed
      </Button>
      {owners.length > 0 && (
        <Select
          value=""
          onValueChange={v => { if (v) onAssignOwner(v === UNASSIGN_VALUE ? null : v) }}
          disabled={disabled}
        >
          <SelectTrigger className="h-7 w-auto min-w-[9.5rem] whitespace-nowrap border-[var(--border-strong)] text-xs data-[placeholder]:text-foreground [&_svg]:text-foreground/70" aria-label="Assign owner">
            <SelectValue placeholder="Assign owner…" />
          </SelectTrigger>
          <SelectContent>
            {/*
              The one bulk owner change the API offers that is not an
              assignment. `bulk-update` reads an explicit `owner_id: null` as
              "clear it across the selection" (tripl-0zpq.276); without an entry
              here it was reachable from the API and MCP only.
            */}
            <SelectItem value={UNASSIGN_VALUE} className="text-xs">
              Unassign
            </SelectItem>
            {owners.map(u => (
              <SelectItem key={u.id} value={u.id} className="text-xs">
                {u.name ?? u.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button
        variant="danger"
        size="sm"
        className="h-7 text-xs"
        onClick={onDelete}
        disabled={disabled}
      >
        <Trash2 className="mr-1 h-3.5 w-3.5" />
        Delete selected
      </Button>
      <div className="hidden h-5 w-px sm:block" style={{ background: 'var(--border)' }} />
      <button
        type="button"
        onClick={onClear}
        className="flex h-6 w-6 items-center justify-center rounded text-[var(--fg-subtle)] hover:text-[var(--fg)]"
        aria-label="Clear selection"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
