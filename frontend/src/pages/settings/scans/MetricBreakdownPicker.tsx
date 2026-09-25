import { Chip } from '@/components/primitives/chip'
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
  appVersionColumn,
  platformColumn,
  valuesLimit,
  onToggleColumn,
  onValuesLimitChange,
  valuesLimitError,
}: {
  columns: ScanConfigPreview['columns']
  selectedColumns: string[]
  eventTypeColumn: string
  timeColumn: string
  appVersionColumn: string
  platformColumn: string
  valuesLimit: string
  onToggleColumn: (column: string) => void
  onValuesLimitChange: (value: string) => void
  /** Why the limit above cannot be saved (DATA-25). */
  valuesLimitError?: string
}) {
  const availableColumns = columns.filter(column => !isJsonPreviewType(column.type_name))
  const reservedColumns = new Set(
    [eventTypeColumn, timeColumn, appVersionColumn, platformColumn].filter(Boolean),
  )

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-body font-medium">Metric breakdowns</div>
          <p className="text-body-sm text-muted-foreground">
            Each selected scalar column is collected as a separate database-level grouping.
          </p>
        </div>
        <div className="grid w-40 gap-1">
          <Label htmlFor="breakdown-value-limit" className="text-body-sm">Value limit</Label>
          <Input
            id="breakdown-value-limit"
            type="number"
            min={1}
            value={valuesLimit}
            onChange={e => onValuesLimitChange(e.target.value)}
            placeholder="Unlimited"
            className="h-8"
            aria-invalid={valuesLimitError ? true : undefined}
            aria-describedby={valuesLimitError ? 'breakdown-value-limit-error' : undefined}
          />
          {valuesLimitError && (
            <p id="breakdown-value-limit-error" className="text-body-sm" style={{ color: 'var(--danger)' }}>
              {valuesLimitError}
            </p>
          )}
        </div>
      </div>
      {selectedColumns.length > 0 && !valuesLimit && (
        <div className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-body-sm text-warning">
          Unlimited breakdowns can be expensive for high-cardinality columns. Set a limit to keep top values and aggregate the rest into Other.
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {availableColumns.map(column => {
          const disabled = reservedColumns.has(column.name)
          return (
            <label
              key={column.name}
              className="flex items-center gap-2 rounded-md border bg-background p-2 text-body"
            >
              <Checkbox
                checked={selectedColumns.includes(column.name)}
                disabled={disabled}
                aria-label={`Breakdown by ${column.name}`}
                onCheckedChange={() => {
                  if (!disabled) onToggleColumn(column.name)
                }}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-body-sm">{column.name}</span>
              {disabled && <Chip variant="outline" size="xs">reserved</Chip>}
            </label>
          )
        })}
      </div>
      {availableColumns.length === 0 && (
        <p className="text-body-sm text-muted-foreground">No scalar columns found in preview.</p>
      )}
    </div>
  )
}
