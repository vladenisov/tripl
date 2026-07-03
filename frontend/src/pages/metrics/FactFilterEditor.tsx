import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Trash2 } from 'lucide-react'
import { SqlEditor } from '@/components/sql-editor'
import { Select, type SelectOption } from '@/components/settings/kit'
import type { DbType } from '@/types/dataSources'
import type { TableSchema } from '@/types/dataSourceSchema'

import { makeNamedFilter, makeSqlFilter, type FactFilter } from './factFilters'

interface FactFilterEditorProps {
  filters: FactFilter[]
  onChange: (next: FactFilter[]) => void
  /** Named filters defined on the operand's fact table. */
  namedOptions: string[]
  dialect?: DbType
  tables?: TableSchema[]
  disabled?: boolean
}

/**
 * Point-and-click editor for an operand's filter list. An "Add filter" button
 * opens a small menu to append either a named or a free-text SQL filter; each
 * row is independently editable and removable. SQL filters use the shared
 * {@link SqlEditor} so they get highlighting + Format.
 */
export function FactFilterEditor({
  filters,
  onChange,
  namedOptions,
  dialect,
  tables,
  disabled,
}: FactFilterEditorProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)

  // The menu is portaled to <body> with fixed coordinates so it escapes the
  // settings card's `overflow-hidden`, which would otherwise clip (and make
  // unclickable) an absolutely-positioned dropdown.
  const toggleMenu = (): void => {
    if (menuOpen) {
      setMenuOpen(false)
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    setMenuPos({ top: (rect?.bottom ?? 0) + 4, left: rect?.left ?? 0 })
    setMenuOpen(true)
  }

  const setName = (id: string, name: string): void =>
    onChange(filters.map(f => (f.id === id && f.kind === 'named' ? { ...f, name } : f)))
  const setSql = (id: string, sql: string): void =>
    onChange(filters.map(f => (f.id === id && f.kind === 'sql' ? { ...f, sql } : f)))
  const remove = (id: string): void => onChange(filters.filter(f => f.id !== id))
  const add = (filter: FactFilter): void => {
    onChange([...filters, filter])
    setMenuOpen(false)
  }

  const namedSelectOptions: SelectOption[] = [
    { value: '', label: 'Select filter…' },
    ...namedOptions.map(name => ({ value: name, label: name })),
  ]

  return (
    <div className="flex flex-col gap-2">
      {filters.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Operand filters">
          {filters.map((filter, index) => (
            <li key={filter.id} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                {filter.kind === 'named' ? (
                  <Select
                    value={filter.name}
                    onChange={value => setName(filter.id, value)}
                    options={namedSelectOptions}
                    disabled={disabled}
                    aria-label={`Filter ${index + 1} named filter`}
                  />
                ) : (
                  <SqlEditor
                    ariaLabel={`Filter ${index + 1} SQL`}
                    value={filter.sql}
                    onChange={value => setSql(filter.id, value)}
                    placeholder="status = 'completed' AND amount > 0"
                    dialect={dialect}
                    tables={tables}
                    minHeight="60px"
                  />
                )}
              </div>
              <button
                type="button"
                onClick={() => remove(filter.id)}
                aria-label={`Remove filter ${index + 1}`}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] border transition-colors hover:bg-[var(--surface-hover)]"
                style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="inline-block">
        <button
          ref={buttonRef}
          type="button"
          disabled={disabled}
          onClick={toggleMenu}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="inline-flex h-8 items-center gap-[6px] rounded-[7px] border px-3 text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-60"
          style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
        >
          <Plus size={12} /> Add filter
        </button>
      </div>
      {menuOpen &&
        createPortal(
          <>
            {/* Backdrop closes the menu on an outside click. */}
            <div className="fixed inset-0 z-[60]" aria-hidden onClick={() => setMenuOpen(false)} />
            <div
              role="menu"
              aria-label="Add filter"
              className="fixed z-[61] min-w-[160px] overflow-hidden rounded-[8px] border py-1 shadow-md"
              style={{
                top: menuPos.top,
                left: menuPos.left,
                background: 'var(--surface)',
                borderColor: 'var(--border)',
              }}
            >
              {namedOptions.length > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => add(makeNamedFilter())}
                  className="block w-full px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--surface-hover)]"
                  style={{ color: 'var(--fg)' }}
                >
                  Named filter
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => add(makeSqlFilter())}
                className="block w-full px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--surface-hover)]"
                style={{ color: 'var(--fg)' }}
              >
                SQL filter
              </button>
            </div>
          </>,
          document.body,
        )}
    </div>
  )
}
