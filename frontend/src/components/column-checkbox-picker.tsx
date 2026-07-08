import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { ColumnSuggestInput } from '@/components/column-suggest'

interface ColumnCheckboxPickerProps {
  id?: string
  /** Known column names to offer as checkboxes. */
  columns: string[]
  /** Currently selected column names. */
  value: string[]
  onChange: (next: string[]) => void
  /** Columns shown disabled with a "reserved" badge (e.g. version/platform dims). */
  reserved?: string[]
  addPlaceholder?: string
  disabled?: boolean
}

/**
 * Column picker mirroring the scans UI: a checkbox grid over the known columns
 * (ticking writes state immediately, so a selection can never be lost as an
 * uncommitted draft) plus a suggestion-backed "add" input for columns the schema
 * cache hasn't caught up to yet. A selected column that isn't in `columns` still
 * renders as a checked box so a saved custom column stays visible and removable.
 */
export function ColumnCheckboxPicker({
  id,
  columns,
  value,
  onChange,
  reserved = [],
  addPlaceholder,
  disabled,
}: ColumnCheckboxPickerProps) {
  const [draft, setDraft] = useState('')
  const reservedSet = new Set(reserved)
  const known = new Set(columns)
  const options = [...columns, ...value.filter(name => !known.has(name))]

  const toggle = (name: string) => {
    if (reservedSet.has(name)) return
    onChange(value.includes(name) ? value.filter(column => column !== name) : [...value, name])
  }

  const addColumns = (raw: string) => {
    const next = [...value]
    for (const part of raw.split(',')) {
      const name = part.trim()
      if (name && !next.includes(name)) next.push(name)
    }
    if (next.length !== value.length) onChange(next)
    setDraft('')
  }

  return (
    <div className="space-y-2">
      {options.length > 0 && (
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
      )}
      <ColumnSuggestInput
        id={id}
        value={draft}
        onChange={setDraft}
        suggestions={columns.filter(name => !value.includes(name))}
        placeholder={addPlaceholder ?? 'Add a column…'}
        disabled={disabled}
        onCommit={addColumns}
        aria-label="Add breakdown column"
      />
    </div>
  )
}
