import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'

interface ColumnCheckboxPickerProps {
  id?: string
  /** Known column names to offer as checkboxes. */
  columns: string[]
  /** Currently selected column names. */
  value: string[]
  onChange: (next: string[]) => void
  /** Columns shown disabled with a "reserved" badge (e.g. version/platform dims). */
  reserved?: string[]
  disabled?: boolean
  'aria-label'?: string
}

/**
 * Column picker mirroring the scans UI: a checkbox grid over the known columns
 * (ticking writes state immediately, so a selection can never be lost as an
 * uncommitted draft). A selected column that isn't in `columns` still renders
 * as a checked box, so a saved custom column stays visible and removable.
 *
 * Checkbox-only by design (tripl-z5rq): the free-text "add a column" input
 * this grid used to embed duplicated the checkbox list in its suggestion
 * dropdown and bypassed the reserved-columns guard, so it was removed.
 */
export function ColumnCheckboxPicker({
  id,
  columns,
  value,
  onChange,
  reserved = [],
  disabled,
  'aria-label': ariaLabel,
}: ColumnCheckboxPickerProps) {
  const reservedSet = new Set(reserved)
  const known = new Set(columns)
  const options = [...columns, ...value.filter(name => !known.has(name))]

  const toggle = (name: string) => {
    if (reservedSet.has(name)) return
    onChange(value.includes(name) ? value.filter(column => column !== name) : [...value, name])
  }

  return (
    <div id={id} role="group" aria-label={ariaLabel}>
      {options.length > 0 ? (
        <div className="grid max-h-[220px] gap-1.5 overflow-y-auto sm:grid-cols-2">
          {options.map(name => {
            const isReserved = reservedSet.has(name)
            return (
              <label
                key={name}
                className="flex items-center gap-2 rounded-[7px] border bg-background p-2 text-xs"
                style={{ borderColor: 'var(--border)' }}
              >
                <Checkbox
                  checked={value.includes(name)}
                  disabled={disabled || isReserved}
                  aria-label={`Break down by ${name}`}
                  onCheckedChange={() => toggle(name)}
                />
                <span className="mono min-w-0 flex-1 truncate">{name}</span>
                {isReserved && (
                  <Badge variant="outline" className="text-[10px]">
                    reserved
                  </Badge>
                )}
              </label>
            )
          })}
        </div>
      ) : (
        <p className="text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
          No columns available yet.
        </p>
      )}
    </div>
  )
}
