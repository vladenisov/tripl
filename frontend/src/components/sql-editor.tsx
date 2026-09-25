import { useCallback, useEffect, useMemo, useRef } from 'react'
import CodeMirror, { type EditorView } from '@uiw/react-codemirror'
import { sql, type SQLNamespace } from '@codemirror/lang-sql'
import { Button } from '@/components/ui/button'
import type { DbType } from '@/types/dataSources'
import type { TableSchema } from '@/types/dataSourceSchema'
import { formatLanguage, highlightDialect } from '@/components/sql-dialects'
import { SqlSchemaBrowser } from '@/components/sql-schema-browser'

// Build the `SQLNamespace` CodeMirror's sql() uses for table/column completion.
// Schema introspection returns cross-database/schema tables qualified as
// `db.table` (bare for the connection's default database); split those on the
// first dot into a nested namespace so `db.` suggests tables and `db.table.`
// suggests columns, while bare tables complete at the top level.
function buildSqlNamespace(tables: readonly TableSchema[]): SQLNamespace {
  const ns: Record<string, string[] | Record<string, string[]>> = {}
  for (const table of tables) {
    const columns = table.columns.map(column => column.name)
    const dot = table.name.indexOf('.')
    if (dot > 0) {
      const db = table.name.slice(0, dot)
      const rest = table.name.slice(dot + 1)
      const existing = ns[db]
      const bucket = existing && !Array.isArray(existing) ? existing : {}
      bucket[rest] = columns
      ns[db] = bucket
    } else if (!(table.name in ns)) {
      ns[table.name] = columns
    }
  }
  return ns as SQLNamespace
}

/**
 * Shared SQL editor: CodeMirror with dialect-aware syntax highlighting and
 * keyword/function completion (ClickHouse / BigQuery / Postgres), schema-aware
 * table+column autocomplete, a one-click dialect-correct Format button, and a
 * collapsible table/column picker that inserts names at the cursor. Editable on
 * four surfaces — the scans base query, the SQL metric query, the fact-table
 * SELECT and the free-text fact row filter — so every place a user writes
 * warehouse SQL gets the same first-class editor, and read-only on the
 * monitoring metric-definition card, which shows the query it ran.
 */
export function SqlEditor({
  value,
  onChange,
  placeholder,
  minHeight,
  dialect,
  tables,
  ariaLabel = 'SQL editor',
  id,
  readOnly = false,
  ariaDescribedBy,
  ariaInvalid = false,
  ariaRequired = false,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  minHeight?: string
  dialect?: DbType
  /** Introspected tables; drives both autocomplete and the table picker. */
  tables?: TableSchema[]
  ariaLabel?: string
  id?: string
  /** Display-only mode: keeps CodeMirror highlighting while disabling edits/tools. */
  readOnly?: boolean
  /**
   * Validation wiring for the editable surface. CodeMirror's focusable element
   * is its inner contenteditable, not the wrapper `id` sits on, so these go
   * onto it through `contentAttributes` — the only place a screen reader looks.
   */
  ariaDescribedBy?: string
  ariaInvalid?: boolean
  ariaRequired?: boolean
}) {
  const viewRef = useRef<EditorView | null>(null)

  // Reshape tables into the `{ table: column[] }` map CodeMirror's sql() uses
  // for table/column autocomplete.
  const schema = useMemo<SQLNamespace | undefined>(() => {
    if (!tables || tables.length === 0) return undefined
    return buildSqlNamespace(tables)
  }, [tables])

  const extensions = useMemo(() => {
    // lang-sql wires up BOTH completion sources for us: keyword/function
    // completion from the dialect word lists, and (when `schema` is set)
    // table/column completion. Tables already complete at the top level — not
    // only after FROM/JOIN — and columns complete after `table.`. When the
    // source exposes exactly one table we mark it `defaultTable` so its columns
    // also complete unqualified (the common single-table metric/fact-table
    // SELECT). `upperCaseKeywords: false` keeps keyword completions lower-case,
    // matching the verbatim word lists in sql-dialects.ts.
    //
    // Note: CodeMirror's own fuzzy matcher only keeps prefix/word-boundary
    // matches for 2-char queries (it drops scattered "gap" matches like `with`
    // for "wh"), so a short query surfaces fewer keywords than a longer one;
    // that ranking lives in @codemirror/autocomplete and is not configurable
    // from here.
    // Only the common single, default-database (bare) table is marked default
    // so its columns complete unqualified; a qualified `db.table` is nested and
    // not a valid defaultTable lookup.
    const onlyTable = tables?.length === 1 ? tables[0] : undefined
    const defaultTable =
      onlyTable && !onlyTable.name.includes('.') ? onlyTable.name : undefined
    return [
      sql({
        dialect: highlightDialect(dialect),
        schema,
        defaultTable,
        upperCaseKeywords: false,
      }),
    ]
  }, [dialect, schema, tables])

  // Mirror the validation attributes onto the contenteditable. Written to the
  // DOM directly (CodeMirror leaves attributes it did not set alone) rather than
  // through an extension, so the editor keeps working behind the test suites'
  // default-export-only mock of @uiw/react-codemirror.
  const applyContentAria = useCallback(
    (view: EditorView | null) => {
      const content = view?.contentDOM
      if (!content) return
      const set = (name: string, value: string | undefined) => {
        if (value) content.setAttribute(name, value)
        else content.removeAttribute(name)
      }
      set('aria-describedby', ariaDescribedBy)
      set('aria-invalid', ariaInvalid ? 'true' : undefined)
      set('aria-required', ariaRequired ? 'true' : undefined)
    },
    [ariaDescribedBy, ariaInvalid, ariaRequired],
  )
  useEffect(() => {
    applyContentAria(viewRef.current)
  }, [applyContentAria])

  // The formatter is its own chunk, fetched on the first click (see
  // sql-format.ts). If the text changed while it loaded, the stale result is
  // dropped rather than overwriting what was typed meanwhile.
  const latestValueRef = useRef(value)
  useEffect(() => {
    latestValueRef.current = value
  }, [value])
  const handleFormat = useCallback(() => {
    const source = value
    void import('@/components/sql-format')
      .then(({ formatSql }) => {
        if (latestValueRef.current !== source) return
        onChange(formatSql(source, formatLanguage(dialect)))
      })
      .catch(() => { /* unparseable SQL or a failed chunk: keep the text as is */ })
  }, [value, onChange, dialect])

  // Insert a table/column name at the cursor (replacing any selection). Adds a
  // leading space only when the preceding char isn't whitespace or an opener,
  // so `count(` + column reads `count(amount`, not `count( amount`.
  const insertToken = useCallback(
    (text: string) => {
      const view = viewRef.current
      if (!view) {
        onChange(value ? `${value} ${text}` : text)
        return
      }
      const { from, to } = view.state.selection.main
      const before = from > 0 ? view.state.sliceDoc(from - 1, from) : ''
      const lead = before !== '' && !/[\s(.,]/.test(before) ? ' ' : ''
      const insert = lead + text
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } })
      view.focus()
    },
    [onChange, value],
  )

  return (
    <div className="flex flex-col gap-1.5">
      {/* `sql-editor` is a styling hook, not decoration: index.css targets
          `.sql-editor .cm-editor .cm-content` to soft-wrap long lines. Renaming
          it here silently stops the wrapping, which is why a test pins the pair
          (tripl-h2sx.33). */}
      <div
        id={id}
        className="sql-editor overflow-hidden rounded-[7px]"
        style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}
      >
        <CodeMirror
          value={value}
          onChange={onChange}
          readOnly={readOnly}
          editable={!readOnly}
          placeholder={placeholder}
          aria-label={ariaLabel}
          extensions={extensions}
          basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
          minHeight={minHeight}
          onCreateEditor={view => {
            viewRef.current = view
            applyContentAria(view)
          }}
        />
      </div>
      {/* Format sits under the editor, not over it: an overlay button covered
          the first line of every query wider than the box — the same fix the
          JSON editor took, in the same shape. The guard wraps the whole row so
          a read-only mount gains no empty strip. */}
      {!readOnly && (
        <div className="flex items-start justify-end gap-2">
          <Button type="button" variant="ghost" size="xs" onClick={handleFormat} className="shrink-0">
            Format
          </Button>
        </div>
      )}
      {!readOnly && tables && tables.length > 0 && (
        <SqlSchemaBrowser tables={tables} onInsert={insertToken} />
      )}
    </div>
  )
}
