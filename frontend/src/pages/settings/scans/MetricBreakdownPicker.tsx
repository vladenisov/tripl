import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ScanConfigPreview } from '@/types'
import { isJsonPreviewType } from './scanUtils'

export function MetricBreakdownPicker({
  columns,
  selectedColumns,
  eventTypeColumn,
  timeColumn,
  valuesLimit,
  onToggleColumn,
  onValuesLimitChange,
}: {
  columns: ScanConfigPreview['columns']
  selectedColumns: string[]
  eventTypeColumn: string
  timeColumn: string
  valuesLimit: string
  onToggleColumn: (column: string) => void
  onValuesLimitChange: (value: string) => void
}) {
  const availableColumns = columns.filter(column => !isJsonPreviewType(column.type_name))
  const reservedColumns = new Set([eventTypeColumn, timeColumn].filter(Boolean))

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Metric breakdowns</div>
          <p className="text-xs text-muted-foreground">
            Each selected scalar column is collected as a separate database-level grouping.
          </p>
        </div>
        <div className="grid w-40 gap-1">
          <Label className="text-xs">Value limit</Label>
          <Input
            type="number"
            min={1}
            value={valuesLimit}
            onChange={e => onValuesLimitChange(e.target.value)}
            placeholder="Unlimited"
            className="h-8"
          />
        </div>
      </div>
      {selectedColumns.length > 0 && !valuesLimit && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Unlimited breakdowns can be expensive for high-cardinality columns. Set a limit to keep top values and aggregate the rest into Other.
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {availableColumns.map(column => {
          const disabled = reservedColumns.has(column.name)
          return (
            <label
              key={column.name}
              className="flex items-center gap-2 rounded-md border bg-background p-2 text-sm"
            >
              <Checkbox
                checked={selectedColumns.includes(column.name)}
                disabled={disabled}
                onCheckedChange={() => {
                  if (!disabled) onToggleColumn(column.name)
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
