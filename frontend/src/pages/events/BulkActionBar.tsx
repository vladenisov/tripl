import { Trash2 } from 'lucide-react'

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
  onDelete,
  onClear,
}: {
  selectedCount: number
  isDeleting: boolean
  isUpdating: boolean
  onSetStatus: (status: EventStatus) => void
  onDelete: () => void
  onClear: () => void
}) {
  if (selectedCount === 0) return null
  const disabled = isDeleting || isUpdating
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
      <span className="text-sm font-medium">{selectedCount} selected</span>
      <Select
        value=""
        onValueChange={v => { if (v) onSetStatus(v as EventStatus) }}
        disabled={disabled}
      >
        <SelectTrigger className="h-8 w-36 text-xs" aria-label="Set status">
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
        variant="destructive"
        size="sm"
        onClick={onDelete}
        disabled={disabled}
      >
        <Trash2 className="mr-1 h-3.5 w-3.5" />
        Delete selected
      </Button>
      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear selection
      </Button>
    </div>
  )
}
