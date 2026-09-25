import { useQuery } from '@tanstack/react-query'
import { dataSourceSchemaApi } from '@/api/dataSourceSchema'

/**
 * Fetches the schema (tables + columns) for a data source so the SQL editor can
 * offer schema-aware autocomplete. Disabled until a data source is selected.
 */
export function useDataSourceSchema(dsId: string | null | undefined) {
  return useQuery({
    queryKey: ['data-source-schema', dsId],
    queryFn: ({ signal }) => dataSourceSchemaApi.get(dsId!, signal),
    enabled: Boolean(dsId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}
