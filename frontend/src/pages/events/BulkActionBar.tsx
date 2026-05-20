import { Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'

export function BulkActionBar({
  selectedCount,
  isDeleting,
  onDelete,
  onClear,
}: {
  selectedCount: number
  isDeleting: boolean
  onDelete: () => void
  onClear: () => void
}) {
  if (selectedCount === 0) return null
  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
      <span className="text-sm font-medium">{selectedCount} selected</span>
      <Button
        variant="destructive"
        size="sm"
        onClick={onDelete}
        disabled={isDeleting}
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
