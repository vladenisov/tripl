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
  isDeleting,
  isUpdating,
  onSetStatus,
  onMarkReviewed,
  onDelete,
  onClear,
}: {
  selectedCount: number
  isDeleting: boolean
  isUpdating: boolean
  onSetStatus: (status: EventStatus) => void
  onMarkReviewed: () => void
  onDelete: () => void
  onClear: () => void
}) {
  if (selectedCount === 0) return null
  const disabled = isDeleting || isUpdating
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
      <div className="h-5 w-px" style={{ background: 'var(--border)' }} />
      <Select
        value=""
        onValueChange={v => { if (v) onSetStatus(v as EventStatus) }}
        disabled={disabled}
      >
        <SelectTrigger className="h-7 w-32 text-xs" aria-label="Set status">
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
        variant="ghost"
        size="sm"
        className="h-7 text-xs"
        onClick={onMarkReviewed}
        disabled={disabled}
      >
        <CheckCheck className="mr-1 h-3.5 w-3.5" />
        Mark reviewed
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs text-muted-foreground hover:text-destructive"
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
