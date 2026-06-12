import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import type { ScanConfigPreview } from '@/types'
import { isJsonPreviewType } from './scanUtils'

export function DistributionDriftPicker({
  columns,
  selectedFields,
  eventTypeColumn,
  timeColumn,
  onToggleField,
}: {
  columns: ScanConfigPreview['columns']
  selectedFields: string[]
  eventTypeColumn: string
  timeColumn: string
  onToggleField: (field: string) => void
}) {
  const availableColumns = columns.filter(column => !isJsonPreviewType(column.type_name))
  const reservedColumns = new Set([eventTypeColumn, timeColumn].filter(Boolean))

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div>
        <div className="text-sm font-medium">Distribution drift</div>
        <p className="text-xs text-muted-foreground">
          Selected scalar fields are compared against their rolling baseline with PSI.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {availableColumns.map(column => {
          const disabled = reservedColumns.has(column.name)
          return (
            <label
              key={column.name}
              className="flex items-center gap-2 rounded-md border bg-background p-2 text-sm"
            >
              <Checkbox
                checked={selectedFields.includes(column.name)}
                disabled={disabled}
                aria-label={`Distribution ${column.name}`}
                onCheckedChange={() => {
                  if (!disabled) onToggleField(column.name)
                }}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{column.name}</span>
              {disabled && <Badge variant="outline" className="text-[10px]">reserved</Badge>}
            </label>
          )
        })}
      </div>
      {availableColumns.length === 0 && (
        <p className="text-xs text-muted-foreground">No scalar columns found in preview.</p>
      )}
    </div>
  )
}
