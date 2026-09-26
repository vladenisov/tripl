import { Chip } from '@/components/primitives/chip'
import { Checkbox } from '@/components/ui/checkbox'
import type { ScanConfigPreview } from '@/types'
import { isJsonPreviewType } from './scanUtils'

const RESERVED_TITLE = 'Used by this scan as its event type, time, app version or platform column.'

export function DistributionDriftPicker({
  columns,
  selectedFields,
  eventTypeColumn,
  timeColumn,
  appVersionColumn,
  platformColumn,
  onToggleField,
}: {
  columns: ScanConfigPreview['columns']
  selectedFields: string[]
  eventTypeColumn: string
  timeColumn: string
  appVersionColumn: string
  platformColumn: string
  onToggleField: (field: string) => void
}) {
  const availableColumns = columns.filter(column => !isJsonPreviewType(column.type_name))
  const reservedColumns = new Set(
    [eventTypeColumn, timeColumn, appVersionColumn, platformColumn].filter(Boolean),
  )

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div>
        <div className="text-body font-medium">Distribution drift</div>
        {/* Plain words first; "PSI" and "scalar" explained nothing to the
            reader choosing columns (#247 DA-16). */}
        <p className="text-body-sm text-muted-foreground">
          tripl watches the mix of values in these columns (e.g. the share of iOS vs Android) and flags
          when it shifts from the usual pattern (population stability index).
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {availableColumns.map(column => {
          const disabled = reservedColumns.has(column.name)
          return (
            <label
              key={column.name}
              className="flex items-center gap-2 rounded-md border bg-background p-2 text-body"
            >
              <Checkbox
                checked={selectedFields.includes(column.name)}
                disabled={disabled}
                aria-label={`Distribution ${column.name}`}
                onCheckedChange={() => {
                  if (!disabled) onToggleField(column.name)
                }}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-body-sm">{column.name}</span>
              {disabled && (
                <Chip variant="outline" size="xs" title={RESERVED_TITLE}>
                  reserved
                </Chip>
              )}
            </label>
          )
        })}
      </div>
      {availableColumns.length === 0 && (
        <p className="text-body-sm text-muted-foreground">
          The preview has no plain-value columns to watch (JSON columns cannot be).
        </p>
      )}
    </div>
  )
}
