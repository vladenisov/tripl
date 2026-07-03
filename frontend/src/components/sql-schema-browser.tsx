import { useMemo, useState } from 'react'
import { ChevronRight, Database, Search } from 'lucide-react'
import type { TableSchema } from '@/types/dataSourceSchema'

/**
 * Collapsible table/column picker rendered under {@link SqlEditor}. Lists the
 * data source's tables (introspected via the schema endpoint); expanding a table
 * reveals its columns with types. Clicking a table or column name inserts it at
 * the editor cursor via `onInsert`. A search box filters by table and column
 * name. Purely presentational — all schema data is supplied by the caller.
 */
export function SqlSchemaBrowser({
  tables,
  onInsert,
}: {
  tables: TableSchema[]
  onInsert: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const q = query.trim().toLowerCase()

  // When searching, every shown table is force-expanded and only its matching
  // columns are listed; otherwise expansion is manual and all columns show.
  const entries = useMemo(() => {
    return tables
      .map(table => {
        const nameMatch = !q || table.name.toLowerCase().includes(q)
        const columns =
          q && !nameMatch
            ? table.columns.filter(column => column.name.toLowerCase().includes(q))
            : table.columns
        return { table, columns, visible: nameMatch || columns.length > 0 }
      })
      .filter(entry => entry.visible)
  }, [tables, q])

  const toggle = (name: string) =>
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const isOpen = (name: string) => Boolean(q) || expanded.has(name)

  return (
    <div className="rounded-[7px]" style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] font-medium"
        style={{ color: 'var(--fg-muted)' }}
      >
        <ChevronRight
          size={12}
          style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}
        />
        <Database size={12} />
        Tables
        <span style={{ color: 'var(--fg-faint)' }}>· {tables.length}</span>
      </button>

      {open && (
        <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <div className="relative px-2 pt-2">
            <Search
              size={12}
              className="pointer-events-none absolute left-[14px] top-1/2 -translate-y-1/2"
              style={{ color: 'var(--fg-faint)', marginTop: 4 }}
            />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Filter tables & columns…"
              aria-label="Filter tables and columns"
              className="w-full"
              style={{
                height: 28,
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--bg-sunken)',
                color: 'var(--fg)',
                fontSize: 12,
                padding: '0 8px 0 26px',
              }}
            />
          </div>

          <ul className="max-h-[220px] overflow-y-auto px-1 py-1.5" aria-label="Schema tables">
            {entries.length === 0 ? (
              <li className="px-2 py-1.5 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                No matching tables.
              </li>
            ) : (
              entries.map(({ table, columns }) => (
                <li key={table.name}>
                  <div className="flex items-center">
                    <button
                      type="button"
                      onClick={() => toggle(table.name)}
                      aria-expanded={isOpen(table.name)}
                      aria-label={`Toggle columns for ${table.name}`}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--surface-hover)]"
                      style={{ color: 'var(--fg-faint)' }}
                    >
                      <ChevronRight
                        size={12}
                        style={{
                          transform: isOpen(table.name) ? 'rotate(90deg)' : 'none',
                          transition: 'transform 120ms',
                        }}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => onInsert(table.name)}
                      title={`Insert ${table.name}`}
                      className="mono min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)]"
                      style={{ color: 'var(--fg)' }}
                    >
                      {table.name}
                    </button>
                  </div>
                  {isOpen(table.name) && (
                    <ul className="mb-1 ml-6 border-l pl-1.5" style={{ borderColor: 'var(--border-subtle)' }}>
                      {columns.map(column => (
                        <li key={column.name}>
                          <button
                            type="button"
                            onClick={() => onInsert(column.name)}
                            title={`Insert ${column.name}`}
                            className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-[3px] text-left transition-colors hover:bg-[var(--surface-hover)]"
                          >
                            <span className="mono truncate text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
                              {column.name}
                            </span>
                            <span className="mono shrink-0 text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
                              {column.data_type}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
