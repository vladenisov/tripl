import { useQuery } from '@tanstack/react-query'
import type { SQLNamespace } from '@codemirror/lang-sql'
import { dataSourceSchemaApi } from '@/api/dataSourceSchema'
import type { TableSchema } from '@/types/dataSourceSchema'

/**
 * Fetches the schema (tables + columns) for a data source so the SQL editor can
 * offer schema-aware autocomplete. Disabled until a data source is selected.
 */
export function useDataSourceSchema(dsId: string | null | undefined) {
  return useQuery({
    queryKey: ['data-source-schema', dsId],
    queryFn: () => dataSourceSchemaApi.get(dsId!),
    enabled: Boolean(dsId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

/** Shape tables into the `{ table: column[] }` map CodeMirror's sql() expects. */
export function toSQLNamespace(tables: TableSchema[]): SQLNamespace {
  return Object.fromEntries(
    tables.map(table => [table.name, table.columns.map(column => column.name)]),
  )
}
