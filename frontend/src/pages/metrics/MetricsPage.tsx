import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { LineChart, Plus, Search } from 'lucide-react'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { PageHead, Panel } from '@/components/settings/kit'
import { Chip, type ChipTone } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import { Sparkline } from '@/components/primitives/sparkline'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { formatRelativeTime } from '@/lib/datetime'
import { getMetricMonitoringPath } from '@/lib/monitoring'
import {
  METRIC_KIND_LABEL,
  METRIC_STATUS_LABEL,
  METRIC_STATUSES,
  type MetricDefinitionListItem,
  type MetricKind,
  type MetricStatus,
} from '@/types'

const METRIC_GRID = 'grid grid-cols-[1.7fr_1fr_104px_84px_84px] items-center gap-3 px-4'

const STATUS_TONE: Record<MetricStatus, ChipTone> = {
  draft: 'neutral',
  active: 'success',
  archived: 'warning',
}

const KIND_FILTER_OPTIONS: { value: '' | MetricKind; label: string }[] = [
  { value: '', label: 'All kinds' },
  { value: 'fact_aggregation', label: 'Fact aggregation' },
  { value: 'sql', label: 'SQL' },
  { value: 'event_composition', label: 'Event composition' },
]

const FILTER_SELECT_CLASS =
  'h-8 rounded-md border bg-[var(--bg)] px-2 text-[12px] text-[var(--fg)] outline-none'

function formatValue(value: number | null | undefined, unit: string | null): string {
  if (value === null || value === undefined) return '—'
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100
  const text = rounded.toLocaleString()
  return unit ? `${text} ${unit}` : text
}

export default function MetricsPage() {
  const { slug } = useParams<{ slug: string }>()
  const [searchInput, setSearchInput] = useState('')
  const [statusFilter, setStatusFilter] = useState<'' | MetricStatus>('')
  const [kindFilter, setKindFilter] = useState<'' | MetricKind>('')
  const search = useDebouncedValue(searchInput, 250)

  const metricsQuery = useQuery({
    queryKey: ['metrics-catalog', slug, statusFilter, kindFilter, search],
    queryFn: () =>
      metricsCatalogApi.list(slug!, {
        status: statusFilter ? [statusFilter] : undefined,
        kind: kindFilter || undefined,
        search: search || undefined,
      }),
    enabled: !!slug,
    staleTime: 30_000,
  })

  const data = metricsQuery.data
  const metrics = useMemo(() => data?.items ?? [], [data])
  const active = metrics.filter(m => m.status === 'active').length
  const draft = metrics.filter(m => m.status === 'draft').length
  const archived = metrics.filter(m => m.status === 'archived').length
  const hasFilters = !!statusFilter || !!kindFilter || !!search
  // Loaded with no metrics AND no active filters — the true "nothing here yet"
  // state, distinct from loading, error, and "filters matched nothing".
  const isEmpty = !metricsQuery.isError && !!data && metrics.length === 0 && !hasFilters

  return (
    <div
      className={
        isEmpty
          ? 'flex min-h-[calc(100vh-7rem)] min-w-0 flex-col gap-6'
          : 'min-w-0 space-y-6 pb-12'
      }
    >
      <PageHead
        eyebrow="Observe"
        title="Metrics"
        right={
          slug ? (
            <Button asChild size="sm">
              <Link to={`/p/${slug}/metrics/new`} className="no-underline">
                <Plus className="h-3.5 w-3.5" />
                New metric
              </Link>
            </Button>
          ) : undefined
        }
      />

      {metricsQuery.isError ? (
        <ErrorState
          title="Metrics unavailable"
          error={metricsQuery.error}
          onRetry={() => {
            void metricsQuery.refetch()
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
          <MiniStat label="Metrics" value={data ? (data.total ?? metrics.length).toLocaleString() : '—'} />
          <MiniStatDivider />
          <MiniStat label="Active" value={data ? active.toLocaleString() : '—'} tone="success" />
          <MiniStatDivider />
          <MiniStat label="Draft" value={data ? draft.toLocaleString() : '—'} />
          <MiniStatDivider />
          <MiniStat
            label="Archived"
            value={data ? archived.toLocaleString() : '—'}
            tone={archived > 0 ? 'warning' : 'neutral'}
          />
        </div>
      )}

      {!metricsQuery.isError &&
        (isEmpty ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={LineChart}
              title="No metrics yet"
              description="Metrics turn a SQL query, a warehouse aggregation, or an event ratio into a tracked time series with anomaly detection. Create one to start collecting."
              action={
                slug ? (
                  <Button asChild size="sm">
                    <Link to={`/p/${slug}/metrics/new`} className="no-underline">
                      <Plus className="h-3.5 w-3.5" />
                      New metric
                    </Link>
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <Panel
            title="Catalog"
            subtitle={data ? `${(data.total ?? metrics.length).toLocaleString()} total` : undefined}
            right={
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
                    style={{ color: 'var(--fg-subtle)' }}
                  />
                  <input
                    aria-label="Search metrics"
                    value={searchInput}
                    onChange={e => setSearchInput(e.target.value)}
                    placeholder="Search…"
                    className={`${FILTER_SELECT_CLASS} w-[160px] pl-7`}
                  />
                </div>
                <select
                  aria-label="Filter by status"
                  value={statusFilter}
                  onChange={e => setStatusFilter(e.target.value as '' | MetricStatus)}
                  className={FILTER_SELECT_CLASS}
                >
                  <option value="">All statuses</option>
                  {METRIC_STATUSES.map(s => (
                    <option key={s} value={s}>
                      {METRIC_STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter by kind"
                  value={kindFilter}
                  onChange={e => setKindFilter(e.target.value as '' | MetricKind)}
                  className={FILTER_SELECT_CLASS}
                >
                  {KIND_FILTER_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            }
          >
            {metricsQuery.isLoading ? (
              <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                Loading…
              </div>
            ) : metrics.length === 0 ? (
              <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                No metrics match the current filters.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div role="table" aria-label="Metrics" className="min-w-[680px]">
                  <div role="rowgroup">
                    <div
                      role="row"
                      className={`${METRIC_GRID} border-b py-2 text-[10.5px] font-semibold uppercase tracking-[0.05em]`}
                      style={{ borderColor: 'var(--border-subtle)', color: 'var(--fg-faint)' }}
                    >
                      <span role="columnheader">Metric</span>
                      <span role="columnheader">Latest</span>
                      <span role="columnheader">Trend</span>
                      <span role="columnheader">Status</span>
                      <span role="columnheader" className="text-right">Updated</span>
                    </div>
                  </div>
                  <div role="rowgroup">
                    {metrics.map(metric => (
                      <MetricRow key={metric.id} metric={metric} slug={slug} />
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

function MetricRow({ metric, slug }: { metric: MetricDefinitionListItem; slug?: string }) {
  const navigate = useNavigate()
  const href = slug ? getMetricMonitoringPath(slug, metric.id) : undefined
  const signal = metric.latest_signal
  // Only a signal from the latest scan reflects an active anomaly. A "recent"
  // (older) signal means the most recent scan was clean, so the current
  // observation is normal — don't pulse the dot, tone the value, or mark the
  // last (now-normal) spark point.
  const isActiveSignal = !!signal && signal.state !== 'recent'
  const signalTone: ChipTone | undefined = isActiveSignal
    ? signal.direction === 'drop'
      ? 'warning'
      : 'danger'
    : undefined
  const anomalyIdx = isActiveSignal && metric.spark.length > 0 ? metric.spark.length - 1 : null

  return (
    <div
      role="row"
      tabIndex={href ? 0 : undefined}
      className={`${METRIC_GRID} border-b py-2.5 last:border-0 ${
        href ? 'cursor-pointer transition-colors hover:bg-[var(--surface-hover)]' : 'cursor-default'
      }`}
      style={{ borderColor: 'var(--border-subtle)' }}
      onClick={href ? () => navigate(href) : undefined}
      onKeyDown={
        href
          ? event => {
              if (
                event.target === event.currentTarget
                && (event.key === 'Enter' || event.key === ' ')
              ) {
                event.preventDefault()
                navigate(href)
              }
            }
          : undefined
      }
    >
      <span role="cell" className="flex min-w-0 items-center gap-2">
        {signalTone ? (
          <Dot tone={signalTone} pulse size={7} />
        ) : (
          <span
            className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
            style={{ background: metric.color }}
          />
        )}
        {href ? (
          <Link
            to={href}
            onClick={event => event.stopPropagation()}
            className="truncate text-[12.5px] font-medium no-underline hover:underline"
            style={{ color: 'var(--fg)' }}
          >
            {metric.display_name}
          </Link>
        ) : (
          <span className="truncate text-[12.5px] font-medium">{metric.display_name}</span>
        )}
        <Chip tone="neutral" size="xs">
          {METRIC_KIND_LABEL[metric.kind]}
        </Chip>
      </span>
      <span
        role="cell"
        className="mono truncate text-[12px]"
        style={{ color: signalTone ? `var(--${signalTone})` : 'var(--fg-subtle)' }}
      >
        {formatValue(metric.latest_value, metric.unit)}
      </span>
      <span role="cell">
        {metric.spark.length > 0 ? (
          <Sparkline data={metric.spark} color={metric.color} anomalyIdx={anomalyIdx} width={96} height={22} />
        ) : (
          <span className="text-[11px]" style={{ color: 'var(--fg-faint)' }}>
            —
          </span>
        )}
      </span>
      <span role="cell">
        <Chip tone={STATUS_TONE[metric.status]} size="xs">
          {METRIC_STATUS_LABEL[metric.status]}
        </Chip>
      </span>
      <span role="cell" className="mono text-right text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
        {formatRelativeTime(metric.updated_at)}
      </span>
    </div>
  )
}
