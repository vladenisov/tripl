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
import { Chip } from '@/components/primitives/chip'
import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import { Skeleton } from '@/components/ui/skeleton'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { formatRelativeTime } from '@/lib/datetime'
import type { FactTableListItem } from '@/types'
import { dataSourcesKey, factTablesKey } from '@/lib/queryKeys'
import { useCanWriteProject } from '@/lib/permissions'

const FACT_TABLE_GRID = 'grid grid-cols-[1.7fr_1fr_1fr_84px] items-center gap-3 px-4'

/**
 * Fact tables list body — the stat rollup and table rows. Rendered as the
 * "Fact tables" tab inside {@link MetricsPage}; owns its own data fetching and
 * spacing but not the page header/tab chrome (the parent provides those). Fact
 * tables exist only to back fact metrics, so they live under Metrics rather
 * than as a standalone surface.
 */
export function FactTablesList({ slug }: { slug?: string }) {
  const canWrite = useCanWriteProject()
  const factTablesQuery = useQuery({
    queryKey: factTablesKey(slug),
    queryFn: () => factTablesApi.list(slug!),
    enabled: !!slug,
    staleTime: 30_000,
  })

  // Resolve data-source ids to names for the table column. The list endpoint
  // returns ids only; data sources are workspace-scoped and small, so a single
  // cached query is cheaper than denormalising names server-side.
  const dataSourcesQuery = useQuery({
    queryKey: dataSourcesKey(),
    queryFn: () => dataSourcesApi.list(),
    // Said inline above the table, with a retry (MET-37).
    meta: SILENT_ERROR_META,
  })
  const dataSourceNamesState: DataSourceNamesState = dataSourcesQuery.isError
    ? 'error'
    : dataSourcesQuery.isPending
      ? 'loading'
      : 'ready'

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
                slug && canWrite ? (
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
          /* "Fact tables", not "Catalog". This panel carried the same
             hardcoded title as the panel on the *other* tab
             (metrics/MetricsCatalog.tsx), so on the Fact tables tab the only
             panel on the page was named after the tab you are not on — its
             header sat 154px below the unselected "Catalog" tab, at the same
             spot the Catalog tab's own panel header occupies, so a reader
             glancing at it to work out where they are got the wrong answer
             (tripl-p4kr).

             Renaming it took the "N total" subtitle with it, on the grounds
             that the stat strip 60px above already states the same number.
             True — and equally true of the Catalog tab, which keeps
             "Catalog / 4 total" under a "METRICS 4" stat. Dropping it here
             only made the two tabs of one page disagree about whether a list
             panel is captioned, so the two panel headers no longer lined up
             (tripl-9jzt). Same expression as MetricsCatalog.tsx:603 so the
             sibling headers stay one shape. */
          <Panel
            title="Fact tables"
            subtitle={data ? `${(data.total ?? factTables.length).toLocaleString()} total` : undefined}
          >
            {factTablesQuery.isLoading ? (
              <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                Loading…
              </div>
            ) : (
              <div className="overflow-x-auto">
                {dataSourceNamesState === 'error' && (
                  <div
                    role="status"
                    className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-[12px]"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--warning)' }}
                  >
                    Data source names could not be loaded.
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11.5px]"
                      onClick={() => {
                        void dataSourcesQuery.refetch()
                      }}
                    >
                      Retry
                    </Button>
                  </div>
                )}
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
                        dataSourceNamesState={dataSourceNamesState}
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

/** Where the id → name lookup for the Data source column stands. */
type DataSourceNamesState = 'loading' | 'error' | 'ready'

interface FactTableRowProps {
  table: FactTableListItem
  slug?: string
  dataSourceName: string | null
  dataSourceNamesState: DataSourceNamesState
}

/**
 * The Data source cell. It used to print "—" for four different things — no
 * source, names still loading, names failed to load, and a source that was
 * deleted — so a broken fact table looked like a slow fetch (MET-37).
 */
function DataSourceCell({
  hasSource,
  name,
  state,
}: {
  hasSource: boolean
  name: string | null
  state: DataSourceNamesState
}) {
  // The FK is ON DELETE SET NULL and the editor requires a source, so a null
  // source means its data source was deleted: that is the main MET-37 case.
  if (!hasSource) {
    return (
      <span title="This fact table has no data source; the one it read was deleted. Pick another in the editor.">
        <Chip tone="warning" size="xs">
          Missing source
        </Chip>
      </span>
    )
  }
  if (name) return <>{name}</>
  if (state === 'loading') {
    return (
      <>
        <Skeleton className="h-3 w-24" />
        <span className="sr-only">Loading data source</span>
      </>
    )
  }
  if (state === 'error') return <span style={{ color: 'var(--fg-faint)' }}>Unavailable</span>
  return (
    <span title="The data source this fact table reads was deleted. Pick another in the editor.">
      <Chip tone="warning" size="xs">
        Missing source
      </Chip>
    </span>
  )
}

function FactTableRow({ table, slug, dataSourceName, dataSourceNamesState }: FactTableRowProps) {
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
        <DataSourceCell
          hasSource={!!table.data_source_id}
          name={dataSourceName}
          state={dataSourceNamesState}
        />
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
