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

export function BulkActionBar({
  selectedCount,
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
  /** Total events matching the current filters/tab (may exceed loaded rows). */
  matchingTotal?: number
  /** Select every matching event so one bulk action sweeps the whole queue. */
  onSelectAllMatching?: () => void
  isSelectingAll?: boolean
  isDeleting: boolean
  isUpdating: boolean
  onSetStatus: (status: EventStatus) => void
  onMarkReviewed: () => void
  onAssignOwner: (userId: string) => void
  owners: { id: string; name: string | null; email: string }[]
  onDelete: () => void
  onClear: () => void
}) {
  if (selectedCount === 0) return null
  const disabled = isDeleting || isUpdating || isSelectingAll
  // Offer to widen the selection to the whole matching set when more events
  // match the filter than are currently selected (bulk triage by prefix/tab).
  const canSelectAll =
    !!onSelectAllMatching && matchingTotal != null && matchingTotal > selectedCount
  return (
    <div
      className="fixed bottom-[18px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-2.5 rounded-[10px] border py-1.5 pl-3.5 pr-2"
      style={{
        background: 'var(--bg-elevated)',
        borderColor: 'var(--border-strong)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <span className="text-[12px]" style={{ color: 'var(--fg-muted)' }}>
        <span className="mono font-semibold" style={{ color: 'var(--fg)' }}>{selectedCount}</span> selected
      </span>
      {canSelectAll && (
        <button
          type="button"
          onClick={onSelectAllMatching}
          disabled={disabled}
          className="text-[12px] font-medium underline-offset-2 hover:underline disabled:opacity-50"
          style={{ color: 'var(--accent)' }}
        >
          {isSelectingAll ? 'Selecting…' : `Select all ${matchingTotal}`}
        </button>
      )}
      <div className="h-5 w-px" style={{ background: 'var(--border)' }} />
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
          onValueChange={v => { if (v) onAssignOwner(v) }}
          disabled={disabled}
        >
          <SelectTrigger className="h-7 w-auto min-w-[9.5rem] whitespace-nowrap border-[var(--border-strong)] text-xs data-[placeholder]:text-foreground [&_svg]:text-foreground/70" aria-label="Assign owner">
            <SelectValue placeholder="Assign owner…" />
          </SelectTrigger>
          <SelectContent>
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
      <div className="h-5 w-px" style={{ background: 'var(--border)' }} />
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
