import { useCallback } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { sql, StandardSQL, PostgreSQL, type SQLDialect, type SQLNamespace } from '@codemirror/lang-sql'
import { format } from 'sql-formatter'
import type { SqlLanguage } from 'sql-formatter'
import { Button } from '@/components/ui/button'
import type { DbType } from '@/types/dataSources'

// Map the source engine to the closest CodeMirror highlighting dialect and the
// exact sql-formatter language. lang-sql ships no ClickHouse/BigQuery dialect,
// so they fall back to StandardSQL for highlighting; sql-formatter, however,
// has dedicated clickhouse/bigquery formatters, so Format stays dialect-correct.
const HIGHLIGHT_DIALECT: Record<DbType, SQLDialect> = {
  postgres: PostgreSQL,
  clickhouse: StandardSQL,
  bigquery: StandardSQL,
}
const FORMAT_LANGUAGE: Record<DbType, SqlLanguage> = {
  postgres: 'postgresql',
  clickhouse: 'clickhouse',
  bigquery: 'bigquery',
}

export function SqlEditor({
  value,
  onChange,
  placeholder,
  minHeight,
  dialect,
  schema,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  minHeight?: string
  dialect?: DbType
  schema?: SQLNamespace
}) {
  const handleFormat = useCallback(() => {
    try {
      onChange(format(value, { language: dialect ? FORMAT_LANGUAGE[dialect] : 'sql' }))
    } catch { /* keep as is */ }
  }, [value, onChange, dialect])

  return (
    <div className="relative">
      <CodeMirror
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        extensions={[sql({ dialect: dialect ? HIGHLIGHT_DIALECT[dialect] : StandardSQL, schema })]}
        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
        minHeight={minHeight}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleFormat}
        className="absolute right-1.5 top-1.5 h-6 text-[10px]"
      >
        Format
      </Button>
    </div>
  )
}
