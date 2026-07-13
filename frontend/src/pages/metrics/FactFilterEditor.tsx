import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, Loader2, Play, Plus, Trash2 } from 'lucide-react'
import { SqlEditor } from '@/components/sql-editor'
import { Select, TextInput, type SelectOption } from '@/components/settings/kit'
import type { DbType } from '@/types/dataSources'
import type { TableSchema } from '@/types/dataSourceSchema'
import type { FactOperandPreviewResponse } from '@/types/metricsCatalog'
import type { FactTableColumn } from '@/types/factTables'

import {
  VALUELESS_CONDITION_OPERATORS,
  makeConditionFilter,
  makeNamedFilter,
  makeSqlFilter,
  type FactConditionOperator,
  type FactFilter,
} from './factFilters'

interface FactFilterEditorProps {
  filters: FactFilter[]
  onChange: (next: FactFilter[]) => void
  /** Named filters defined on the operand's fact table. */
  namedOptions: string[]
  /** Columns defined on the operand's fact table. */
  conditionColumns?: FactTableColumn[]
  dialect?: DbType
  tables?: TableSchema[]
  disabled?: boolean
  /**
   * Run the filters against the warehouse (a stateless dry-run of the compiled
   * WHERE). Omitted while the operand has no fact table to compile against, in
   * which case the Check button is not rendered at all.
   */
  onCheck?: () => void
  checkPending?: boolean
  /** Last dry-run outcome; `error` set means the warehouse (or the compiler) said no. */
  checkResult?: FactOperandPreviewResponse | null
  /** Transport-level failure (the check never reached a verdict). */
  checkError?: string | null
}

/**
 * Point-and-click editor for an operand's filter list. An "Add filter" button
 * opens a small menu to append either a named or a free-text SQL filter; each
 * row is independently editable and removable. SQL filters use the shared
 * {@link SqlEditor} so they get highlighting + Format.
 *
 * "Check filters" dry-runs the list against the warehouse. Until it existed, a
 * fact metric's filters were only ever executed inside a Celery worker — so a
 * filter that the selected engine rejects was saved happily and failed later,
 * out of sight. The check compiles the filters exactly as the collector does and
 * runs them, so a green check means the collection will not fail on this SQL.
 */
export function FactFilterEditor({
  filters,
  onChange,
  namedOptions,
  conditionColumns = [],
  dialect,
  tables,
  disabled,
  onCheck,
  checkPending = false,
  checkResult = null,
  checkError = null,
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
  const setCondition = (
    id: string,
    patch: Partial<Extract<FactFilter, { kind: 'condition' }>>,
  ): void =>
    onChange(
      filters.map(f => (f.id === id && f.kind === 'condition' ? { ...f, ...patch } : f)),
    )
  const remove = (id: string): void => onChange(filters.filter(f => f.id !== id))
  const add = (filter: FactFilter): void => {
    onChange([...filters, filter])
    setMenuOpen(false)
  }

  const namedSelectOptions: SelectOption[] = [
    { value: '', label: 'Select filter…' },
    ...namedOptions.map(name => ({ value: name, label: name })),
  ]
  const conditionColumnOptions: SelectOption[] = [
    { value: '', label: 'Select column…' },
    ...conditionColumns.map(column => ({
      value: column.name,
      label: `${column.name} · ${column.type}`,
    })),
  ]
  const conditionOperatorOptions: SelectOption[] = CONDITION_OPERATORS.map(operator => ({
    value: operator.value,
    label: operator.label,
  }))

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
                ) : filter.kind === 'condition' ? (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(150px,1fr)_120px_minmax(150px,1fr)]">
                    <Select
                      value={filter.column}
                      onChange={value => setCondition(filter.id, { column: value })}
                      options={conditionColumnOptions}
                      disabled={disabled}
                      aria-label={`Filter ${index + 1} condition column`}
                    />
                    <Select
                      value={filter.operator}
                      onChange={value =>
                        setCondition(filter.id, { operator: value as FactConditionOperator })
                      }
                      options={conditionOperatorOptions}
                      disabled={disabled}
                      aria-label={`Filter ${index + 1} condition operator`}
                    />
                    {!VALUELESS_CONDITION_OPERATORS.has(filter.operator) && (
                      <TextInput
                        value={filter.value}
                        onChange={value => setCondition(filter.id, { value })}
                        placeholder={filter.operator === 'in' || filter.operator === 'not_in' ? 'a, b, c' : 'value'}
                        disabled={disabled}
                        aria-label={`Filter ${index + 1} condition value`}
                      />
                    )}
                  </div>
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

      <div className="flex items-center gap-2">
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
        {onCheck && (
          <button
            type="button"
            disabled={disabled || checkPending}
            onClick={onCheck}
            className="inline-flex h-8 items-center gap-[6px] rounded-[7px] border px-3 text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-60"
            style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
          >
            {checkPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Play size={12} />
            )}
            {checkPending ? 'Checking…' : 'Check filters'}
          </button>
        )}
      </div>

      <FilterCheckPanel result={checkResult} transportError={checkError} />
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
                onClick={() => add(makeConditionFilter())}
                className="block w-full px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--surface-hover)]"
                style={{ color: 'var(--fg)' }}
              >
                Condition
              </button>
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

interface FilterCheckPanelProps {
  result: FactOperandPreviewResponse | null
  transportError: string | null
}

/**
 * Outcome of the filter dry-run. A compiler or warehouse rejection arrives as a
 * 200 with `error` set (it is a verdict on the user's filters, not a server
 * fault) and renders in the danger style with the engine's own wording; a
 * transport failure renders the same way. A clean run says so explicitly —
 * "no rows matched" is NOT an error, so it is called out separately, since valid
 * SQL that matches nothing is a filter-value mistake, not a SQL mistake.
 */
function FilterCheckPanel({ result, transportError }: FilterCheckPanelProps) {
  const message = transportError ?? result?.error ?? null
  if (message) {
    return (
      <div
        role="alert"
        className="rounded-[10px] border px-4 py-3 text-[12.5px]"
        style={{
          background: 'var(--danger-soft)',
          borderColor: 'color-mix(in oklab, var(--danger) 35%, var(--border))',
          color: 'var(--danger)',
        }}
      >
        {message}
      </div>
    )
  }
  if (!result) return null
  return (
    <div
      role="status"
      className="flex items-center gap-[6px] rounded-[10px] border px-4 py-3 text-[12.5px]"
      style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
    >
      <CheckCircle2 size={13} style={{ color: 'var(--success, var(--fg-muted))' }} />
      {result.row_count > 0
        ? 'Filters ran clean against the warehouse.'
        : 'Filters ran clean against the warehouse, but matched no rows in the last 7 days.'}
    </div>
  )
}

const CONDITION_OPERATORS: { value: FactConditionOperator; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'ne', label: '!=' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'like', label: 'like' },
  { value: 'not_like', label: 'not like' },
  { value: 'in', label: 'in' },
  { value: 'not_in', label: 'not in' },
  { value: 'is_null', label: 'is null' },
  { value: 'is_not_null', label: 'is not null' },
  { value: 'is_true', label: 'is true' },
  { value: 'is_false', label: 'is false' },
]
