import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Plus, Sheet } from 'lucide-react'
import { dataSourcesApi } from '@/api/dataSources'
import { factTablesApi } from '@/api/factTablesApi'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { Panel } from '@/components/settings/kit'
import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import { formatRelativeTime } from '@/lib/datetime'
import type { FactTableListItem } from '@/types'

const FACT_TABLE_GRID = 'grid grid-cols-[1.7fr_1fr_1fr_84px] items-center gap-3 px-4'

/**
 * Fact tables list body — the stat rollup and table rows. Rendered as the
 * "Fact tables" tab inside {@link MetricsPage}; owns its own data fetching and
 * spacing but not the page header/tab chrome (the parent provides those). Fact
 * tables exist only to back fact metrics, so they live under Metrics rather
 * than as a standalone surface.
 */
export function FactTablesList({ slug }: { slug?: string }) {
  const factTablesQuery = useQuery({
    queryKey: ['fact-tables', slug],
    queryFn: () => factTablesApi.list(slug!),
    enabled: !!slug,
    staleTime: 30_000,
  })

  // Resolve data-source ids to names for the table column. The list endpoint
  // returns ids only; data sources are workspace-scoped and small, so a single
  // cached query is cheaper than denormalising names server-side.
  const dataSourcesQuery = useQuery({
    queryKey: ['data-sources'],
    queryFn: () => dataSourcesApi.list(),
  })

  const data = factTablesQuery.data
  const factTables = useMemo(() => data?.items ?? [], [data])
  const dataSourceNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const ds of dataSourcesQuery.data ?? []) map.set(ds.id, ds.name)
    return map
  }, [dataSourcesQuery.data])

  // Loaded with no fact tables — the true "nothing here yet" state, distinct
  // from loading and error.
  const isEmpty = !factTablesQuery.isError && !!data && factTables.length === 0

  return (
    <div className={isEmpty ? 'flex min-h-[calc(100vh-14rem)] flex-col gap-6' : 'space-y-6'}>
      {factTablesQuery.isError ? (
        <ErrorState
          title="Fact tables unavailable"
          error={factTablesQuery.error}
          onRetry={() => {
            void factTablesQuery.refetch()
          }}
          retryLabel="Retry"
          compact
        />
      ) : (
        <div
          className={`flex flex-wrap items-center gap-x-6 gap-y-4 rounded-lg border px-4 py-3 ${
            isEmpty ? 'opacity-60' : ''
          }`}
          style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)' }}
        >
          <MiniStat
            label="Fact tables"
            value={data ? (data.total ?? factTables.length).toLocaleString() : '—'}
          />
          <MiniStatDivider />
          <MiniStat
            label="Data sources"
            value={data ? new Set(factTables.map(t => t.data_source_id).filter(Boolean)).size.toLocaleString() : '—'}
          />
        </div>
      )}

      {!factTablesQuery.isError &&
        (isEmpty ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={Sheet}
              title="No fact tables yet"
              description="A fact table wraps a read-only SELECT or WITH ... SELECT into a reusable, column-introspected source. Define one, then build fact metrics that aggregate its columns."
              action={
                slug ? (
                  <Button asChild size="sm">
                    <Link to={`/p/${slug}/metrics/fact-tables/new`} className="no-underline">
                      <Plus className="h-3.5 w-3.5" />
                      New fact table
                    </Link>
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <Panel
            title="Catalog"
            subtitle={
              data ? `${(data.total ?? factTables.length).toLocaleString()} total` : undefined
            }
          >
            {factTablesQuery.isLoading ? (
              <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                Loading…
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div role="table" aria-label="Fact tables" className="min-w-[680px]">
                  <div role="rowgroup">
                    <div
                      role="row"
                      className={`${FACT_TABLE_GRID} border-b py-2 text-[10.5px] font-semibold uppercase tracking-[0.05em]`}
                      style={{ borderColor: 'var(--border-subtle)', color: 'var(--fg-faint)' }}
                    >
                      <span role="columnheader">Fact table</span>
                      <span role="columnheader">Data source</span>
                      <span role="columnheader">Timestamp column</span>
                      <span role="columnheader" className="text-right">Updated</span>
                    </div>
                  </div>
                  <div role="rowgroup">
                    {factTables.map(table => (
                      <FactTableRow
                        key={table.id}
                        table={table}
                        slug={slug}
                        dataSourceName={
                          table.data_source_id
                            ? dataSourceNames.get(table.data_source_id) ?? null
                            : null
                        }
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </Panel>
        ))}
    </div>
  )
}

interface FactTableRowProps {
  table: FactTableListItem
  slug?: string
  dataSourceName: string | null
}

function FactTableRow({ table, slug, dataSourceName }: FactTableRowProps) {
  const href = slug ? `/p/${slug}/metrics/fact-tables/${table.id}/edit` : undefined

  return (
    <div
      role="row"
      className={`${FACT_TABLE_GRID} border-b py-2.5 last:border-0 ${
        href ? 'transition-colors hover:bg-[var(--surface-hover)]' : ''
      }`}
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      <span role="cell" className="flex min-w-0 items-center gap-2">
        <span
          className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
          style={{ background: table.color }}
        />
        {href ? (
          <Link
            to={href}
            className="truncate text-[12.5px] font-medium no-underline hover:underline"
            style={{ color: 'var(--fg)' }}
          >
            {table.display_name}
          </Link>
        ) : (
          <span className="truncate text-[12.5px] font-medium">{table.display_name}</span>
        )}
        <span className="mono truncate text-[11px]" style={{ color: 'var(--fg-faint)' }}>
          {table.name}
        </span>
      </span>
      <span role="cell" className="truncate text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
        {dataSourceName ?? <span style={{ color: 'var(--fg-faint)' }}>—</span>}
      </span>
      <span role="cell" className="mono truncate text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
        {table.timestamp_column || <span style={{ color: 'var(--fg-faint)' }}>—</span>}
      </span>
      <span role="cell" className="mono text-right text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
        {formatRelativeTime(table.updated_at)}
      </span>
    </div>
  )
}
