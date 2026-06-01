import { Archive, ArchiveRestore, Eye, RotateCcw, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'

export function BulkActionBar({
  selectedCount,
  isDeleting,
  isUpdating,
  onMarkReviewed,
  onSendToReview,
  onArchive,
  onRestore,
  onDelete,
  onClear,
}: {
  selectedCount: number
  isDeleting: boolean
  isUpdating: boolean
  onMarkReviewed: () => void
  onSendToReview: () => void
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
  onClear: () => void
}) {
  if (selectedCount === 0) return null
  const disabled = isDeleting || isUpdating
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
      <span className="text-sm font-medium">{selectedCount} selected</span>
      <Button
        variant="outline"
        size="sm"
        onClick={onMarkReviewed}
        disabled={disabled}
      >
        <Eye className="mr-1 h-3.5 w-3.5" />
        Mark reviewed
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onSendToReview}
        disabled={disabled}
      >
        <RotateCcw className="mr-1 h-3.5 w-3.5" />
        Send to review
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onArchive}
        disabled={disabled}
      >
        <Archive className="mr-1 h-3.5 w-3.5" />
        Archive
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onRestore}
        disabled={disabled}
      >
        <ArchiveRestore className="mr-1 h-3.5 w-3.5" />
        Restore
      </Button>
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
