import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Archive,
  ArchiveRestore,
  Copy,
  GripVertical,
  LineChart,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react'
import { toast } from 'sonner'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { Panel } from '@/components/settings/kit'
import { Chip, type ChipTone } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import { Sparkline } from '@/components/primitives/sparkline'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useEventsDndSensors } from '@/pages/events/useEventsDndSensors'
import { formatDateTime, formatRelativeTime } from '@/lib/datetime'
import { formatMetricValue } from '@/lib/metricFormat'
import { getMetricMonitoringPath } from '@/lib/monitoring'
import { getErrorMessage } from '@/lib/utils'
import {
  METRIC_KIND_LABEL,
  METRIC_STATUS_LABEL,
  METRIC_STATUSES,
  type EventCompositionMetricCreate,
  type FactMetricCreate,
  type MetricAggregation,
  type MetricCreate,
  type MetricDefinitionListItem,
  type MetricDefinitionListResponse,
  type MetricDefinitionResponse,
  type MetricKind,
  type MetricScanInterval,
  type MetricStatus,
  type SqlMetricCreate,
} from '@/types'

const METRIC_GRID =
  'grid grid-cols-[18px_20px_minmax(0,1.3fr)_minmax(0,1fr)_104px_84px_84px_28px] items-center gap-3 px-4'

const STATUS_TONE: Record<MetricStatus, ChipTone> = {
  draft: 'neutral',
  active: 'success',
  archived: 'warning',
}

const KIND_FILTER_OPTIONS: { value: '' | MetricKind; label: string }[] = [
  { value: '', label: 'All kinds' },
  { value: 'fact', label: 'Fact' },
  { value: 'sql', label: 'SQL' },
  { value: 'event_composition', label: 'Event composition' },
]

const FILTER_SELECT_CLASS =
  'h-8 rounded-md border bg-[var(--bg)] px-2 text-[12px] text-[var(--fg)] outline-none'

// Human-readable collection cadence, used as the Latest-cell tooltip context
// when a metric has no known bucket timestamp for its latest value
// (tripl-nxk2.11). Mirrors the backend ScanInterval enum.
const INTERVAL_LABEL: Record<MetricScanInterval, string> = {
  '15m': 'every 15 min',
  '1h': 'hourly',
  '6h': 'every 6 h',
  '1d': 'daily',
  '1w': 'weekly',
}

// Interval → milliseconds, for the staleness threshold (tripl-nxk2.10).
const INTERVAL_MS: Record<MetricScanInterval, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
}

// A metric is "stale" once its freshest bucket is older than this many
// intervals — long enough that a scheduled collection was almost certainly
// missed, not merely running a little late.
const STALE_INTERVAL_MULTIPLIER = 3

type SignalFilter = 'anomalies' | 'stale'

// A latest-scan signal (state !== 'recent') is an active anomaly on the most
// recent scan; a 'recent' signal means the newest scan was already clean.
// Mirrors the per-row `isActiveSignal` check in MetricRow.
function hasActiveSignal(metric: MetricDefinitionListItem): boolean {
  return !!metric.latest_signal && metric.latest_signal.state !== 'recent'
}

// Staleness path (tripl-nxk2.10): MetricDefinitionListItem DOES carry a
// last-bucket timestamp (`latest_bucket`) alongside the collection `interval`,
// so we compute real staleness rather than fabricating a signal or falling back
// to a Draft count. Only ACTIVE metrics can be stale — drafts never started
// collecting and archived metrics were stopped on purpose — and only when the
// freshest bucket is older than STALE_INTERVAL_MULTIPLIER × the interval. A
// metric with no bucket or no interval is treated as not-yet-collecting.
function isStaleMetric(metric: MetricDefinitionListItem, now: number): boolean {
  if (metric.status !== 'active') return false
  if (!metric.latest_bucket || !metric.interval) return false
  const intervalMs = INTERVAL_MS[metric.interval]
  if (!intervalMs) return false
  const bucketTs = Date.parse(metric.latest_bucket)
  if (Number.isNaN(bucketTs)) return false
  return now - bucketTs > STALE_INTERVAL_MULTIPLIER * intervalMs
}

// A clickable stat cell: wraps a MiniStat (a <dl>, not a button) in an
// accessible role="button" so an operational count doubles as a one-click table
// filter (tripl-nxk2.10). Keyboard (Enter/Space) + aria-pressed included; the
// negative vertical margin keeps the hover/focus padding from shifting the
// stat-bar baseline.
function StatFilter({
  active,
  onToggle,
  label,
  children,
}: {
  active: boolean
  onToggle: () => void
  label: string
  children: ReactNode
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={label}
      onClick={onToggle}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggle()
        }
      }}
      className={`-my-1 cursor-pointer rounded-md px-2 py-1 outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
        active ? 'bg-[var(--surface-hover)]' : ''
      }`}
    >
      {children}
    </div>
  )
}

// The single fact operand shape (numerator / denominator) sent to the backend —
// derived from the generated create schema so it stays in lock-step.
type FactOperandPayload = NonNullable<FactMetricCreate['numerator']>

// A metric's internal name is a lowercase [a-z0-9_] identifier. Derive a unique
// copy name: `<name>_copy`, then `_2` / `_3`… on collision against the loaded
// catalog. The source name is already a valid identifier, so the suffix keeps it
// one (tripl-nxk2.9).
function makeCopyName(baseName: string, existing: ReadonlySet<string>): string {
  const root = `${baseName}_copy`
  if (!existing.has(root)) return root
  let suffix = 2
  while (existing.has(`${root}_${suffix}`)) suffix += 1
  return `${root}_${suffix}`
}

// Narrow one fact operand out of a stored fact-metric config sub-object (a ratio
// numerator/denominator). Untrusted JSON, so every field is read defensively.
function readFactOperand(raw: unknown): FactOperandPayload {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const strOrNull = (key: string): string | null =>
    typeof obj[key] === 'string' ? (obj[key] as string) : null
  return {
    fact_table_id: typeof obj['fact_table_id'] === 'string' ? (obj['fact_table_id'] as string) : '',
    aggregation: (obj['aggregation'] as MetricAggregation | undefined) ?? 'count',
    measure_column: strOrNull('measure_column'),
    distinct_column: strOrNull('distinct_column'),
    row_filters: Array.isArray(obj['row_filters']) ? (obj['row_filters'] as string[]) : [],
    filter_sql: strOrNull('filter_sql'),
  }
}

/**
 * Map a loaded metric definition to a fresh create payload for "Duplicate as
 * draft": copy presentation + kind-specific collection config verbatim for all
 * three kinds, overriding only identity (display/internal name) and forcing
 * `status: 'draft'`. The response nests kind config under `config`; the create
 * union expects it at the shapes {@link MetricForm} builds, so each kind is
 * remapped explicitly.
 */
function buildDuplicatePayload(
  def: MetricDefinitionResponse,
  displayName: string,
  name: string,
): MetricCreate {
  const config = def.config
  const strOrNull = (key: string): string | null =>
    typeof config[key] === 'string' ? (config[key] as string) : null
  const base = {
    anomaly_detection_enabled: def.anomaly_detection_enabled,
    app_version_column: def.app_version_column,
    breakdown_columns: def.breakdown_columns,
    breakdown_values_limit: def.breakdown_values_limit,
    color: def.color,
    description: def.description,
    display_name: displayName,
    name,
    order: def.order,
    owner_id: def.owner_id,
    platform_column: def.platform_column,
    reviewed: def.reviewed,
    status: 'draft' as const,
    unit: def.unit,
  }

  if (def.kind === 'sql') {
    const payload: SqlMetricCreate = {
      ...base,
      kind: 'sql',
      interval: def.interval ?? '1h',
      data_source_id: def.data_source_id ?? '',
      config: {
        metric_sql: typeof config['metric_sql'] === 'string' ? (config['metric_sql'] as string) : '',
        time_column: typeof config['time_column'] === 'string' ? (config['time_column'] as string) : '',
        value_column: strOrNull('value_column'),
      },
      replay_chunk_interval: def.replay_chunk_interval,
    }
    return payload
  }

  if (def.kind === 'fact') {
    if (def.composition === 'ratio') {
      const payload: FactMetricCreate = {
        ...base,
        kind: 'fact',
        composition: 'ratio',
        interval: def.interval ?? '1h',
        numerator: readFactOperand(config['numerator']),
        denominator: readFactOperand(config['denominator']),
        replay_chunk_interval: def.replay_chunk_interval,
      }
      return payload
    }
    const payload: FactMetricCreate = {
      ...base,
      kind: 'fact',
      composition: 'single',
      interval: def.interval ?? '1h',
      fact_table_id: def.fact_table_id,
      aggregation: def.aggregation,
      measure_column: strOrNull('measure_column'),
      distinct_column: strOrNull('distinct_column'),
      row_filters: Array.isArray(config['row_filters']) ? (config['row_filters'] as string[]) : [],
      filter_sql: strOrNull('filter_sql'),
      replay_chunk_interval: def.replay_chunk_interval,
    }
    return payload
  }

  const payload: EventCompositionMetricCreate = {
    ...base,
    kind: 'event_composition',
    composition: def.composition ?? 'single',
    numerator_event_id: def.numerator_event_id,
    numerator_event_type_id: def.numerator_event_type_id,
    denominator_event_id: def.denominator_event_id,
    denominator_event_type_id: def.denominator_event_type_id,
    user_id_column: strOrNull('user_id_column'),
  }
  return payload
}

/**
 * Metrics catalog body — the stat rollup, filters, and metric rows. Rendered as
 * the "Catalog" tab inside {@link MetricsPage}; owns its own data fetching and
 * spacing but not the page header/tab chrome (the parent provides those).
 */
export function MetricsCatalog({ slug }: { slug?: string }) {
  const qc = useQueryClient()
  const [searchInput, setSearchInput] = useState('')
  const [statusFilter, setStatusFilter] = useState<'' | MetricStatus>('')
  const [kindFilter, setKindFilter] = useState<'' | MetricKind>('')
  // Client-side derived filter driven by the operational stat cells; layered on
  // top of the server-side status/kind/search filters (tripl-nxk2.10).
  const [signalFilter, setSignalFilter] = useState<SignalFilter | null>(null)
  // "Now" snapshotted once at mount for staleness comparisons — a stable render
  // input (Date.now() during render is impure); mirrors ScansTab's mountedAtMs.
  const [nowMs] = useState(() => Date.now())
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const search = useDebouncedValue(searchInput, 250)

  const queryKey = ['metrics-catalog', slug, statusFilter, kindFilter, search] as const
  const metricsQuery = useQuery({
    queryKey,
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
  // Internal names of the loaded catalog — the collision set for the "Duplicate
  // as draft" copy-name suffixing.
  const existingNames = useMemo(() => new Set(metrics.map(m => m.name)), [metrics])
  const active = metrics.filter(m => m.status === 'active').length
  // Operational rollups derived from the loaded list (tripl-nxk2.10). Counts
  // reflect every loaded metric regardless of the client-side signal filter, so
  // clicking a stat to filter never changes its own number.
  const anomalyCount = useMemo(() => metrics.filter(hasActiveSignal).length, [metrics])
  const staleCount = useMemo(
    () => metrics.filter(m => isStaleMetric(m, nowMs)).length,
    [metrics, nowMs],
  )
  // Widest sparkline in the loaded set → the real "last N points" the Trend
  // column represents (tripl-nxk2.11). Each spark is a trailing, bounded window
  // of metric-value buckets, so the point count is the honest, data-derived
  // label; the wall-clock window differs per metric interval and isn't knowable
  // at the column level.
  const trendPoints = useMemo(
    () => metrics.reduce((max, m) => Math.max(max, m.spark.length), 0),
    [metrics],
  )
  // Client-side view over the loaded list, applied on top of the server-side
  // status/kind/search filters (tripl-nxk2.10).
  const visibleMetrics = useMemo(() => {
    if (signalFilter === 'anomalies') return metrics.filter(hasActiveSignal)
    if (signalFilter === 'stale') return metrics.filter(m => isStaleMetric(m, nowMs))
    return metrics
  }, [metrics, signalFilter, nowMs])
  const hasFilters = !!statusFilter || !!kindFilter || !!search || !!signalFilter
  // Loaded with no metrics AND no active filters — the true "nothing here yet"
  // state, distinct from loading, error, and "filters matched nothing".
  const isEmpty = !metricsQuery.isError && !!data && metrics.length === 0 && !hasFilters

  // Reorder only makes sense against the full, unfiltered catalog: a partial
  // list can't express the canonical order the backend persists.
  const canReorder = !hasFilters && metrics.length > 1

  const selected = useMemo(
    () => visibleMetrics.filter(m => selectedIds.has(m.id)),
    [visibleMetrics, selectedIds],
  )
  const allSelected = visibleMetrics.length > 0 && selected.length === visibleMetrics.length

  const toggleSelected = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(visibleMetrics.map(m => m.id)))
  }
  // Filter/search changes swap the visible set; carrying hidden selections
  // across views would let a later bulk action silently hit rows the user
  // no longer sees — so every view change starts with a clean slate.
  const clearSelectionAnd = <T,>(setter: (value: T) => void) => (value: T) => {
    setSelectedIds(new Set())
    // A server-side filter change swaps the loaded set out from under the
    // client-side signal filter, so drop it too (tripl-nxk2.10).
    setSignalFilter(null)
    setter(value)
  }
  // Toggling a stat cell filters the table to that operational slice; clicking
  // the active one clears it. Mirrors clearSelectionAnd — every view change
  // starts with a clean selection so a later bulk action can't hit hidden rows.
  const toggleSignalFilter = (filter: SignalFilter) => {
    setSelectedIds(new Set())
    setSignalFilter(prev => (prev === filter ? null : filter))
  }

  const bulkStatusMut = useMutation({
    mutationFn: (status: MetricStatus) =>
      metricsCatalogApi.bulkUpdate(slug!, {
        metric_ids: selected.map(m => m.id),
        status,
      }),
    onSuccess: () => {
      setSelectedIds(new Set())
      void qc.invalidateQueries({ queryKey: ['metrics-catalog', slug] })
    },
  })

  const reorderMut = useMutation({
    mutationFn: (metricIds: string[]) =>
      metricsCatalogApi.reorder(slug!, { metric_ids: metricIds }),
    onMutate: async (metricIds: string[]) => {
      // Optimistic: repaint rows in the dropped order while the PATCH runs.
      await qc.cancelQueries({ queryKey })
      const previous = qc.getQueryData<MetricDefinitionListResponse>(queryKey)
      if (previous) {
        const byId = new Map(previous.items.map(item => [item.id, item]))
        qc.setQueryData<MetricDefinitionListResponse>(queryKey, {
          ...previous,
          items: metricIds
            .map(id => byId.get(id))
            .filter((item): item is MetricDefinitionListItem => item !== undefined),
        })
      }
      return { previous }
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) qc.setQueryData(queryKey, context.previous)
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['metrics-catalog', slug] })
    },
  })

  // Shared pointer+keyboard sensor pair — keyboard so the handle's injected
  // "press space to lift" instructions are actually true.
  const sensors = useEventsDndSensors()
  const handleDragEnd = (event: DragEndEvent) => {
    const { active: dragged, over } = event
    if (!over || dragged.id === over.id) return
    const oldIndex = metrics.findIndex(m => m.id === dragged.id)
    const newIndex = metrics.findIndex(m => m.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    reorderMut.mutate(arrayMove(metrics, oldIndex, newIndex).map(m => m.id))
  }

  return (
    <div className={isEmpty ? 'flex min-h-[calc(100vh-14rem)] flex-col gap-6' : 'space-y-6'}>
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
          <StatFilter
            active={signalFilter === 'anomalies'}
            onToggle={() => toggleSignalFilter('anomalies')}
            label="Filter by active anomalies"
          >
            <MiniStat
              label="Anomalies"
              value={
                <span style={{ color: anomalyCount > 0 ? 'var(--danger)' : undefined }}>
                  {data ? anomalyCount.toLocaleString() : '—'}
                </span>
              }
              tone={anomalyCount > 0 ? 'danger' : 'neutral'}
            />
          </StatFilter>
          <MiniStatDivider />
          <StatFilter
            active={signalFilter === 'stale'}
            onToggle={() => toggleSignalFilter('stale')}
            label="Filter by stale metrics"
          >
            <MiniStat
              label="Stale"
              value={
                <span style={{ color: staleCount > 0 ? 'var(--warning)' : undefined }}>
                  {data ? staleCount.toLocaleString() : '—'}
                </span>
              }
              tone={staleCount > 0 ? 'warning' : 'neutral'}
            />
          </StatFilter>
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
                    onChange={e => clearSelectionAnd(setSearchInput)(e.target.value)}
                    placeholder="Search…"
                    className={`${FILTER_SELECT_CLASS} w-[160px] pl-7`}
                  />
                </div>
                <select
                  aria-label="Filter by status"
                  value={statusFilter}
                  onChange={e =>
                    clearSelectionAnd(setStatusFilter)(e.target.value as '' | MetricStatus)
                  }
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
                  onChange={e =>
                    clearSelectionAnd(setKindFilter)(e.target.value as '' | MetricKind)
                  }
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
            {selected.length > 0 && (
              <div
                className="flex flex-wrap items-center gap-2 border-b px-4 py-2"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-sunken)' }}
              >
                <span className="text-[12px] font-medium" style={{ color: 'var(--fg)' }}>
                  {selected.length} selected
                </span>
                {METRIC_STATUSES.map(status => (
                  <Button
                    key={status}
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11.5px]"
                    disabled={bulkStatusMut.isPending}
                    onClick={() => bulkStatusMut.mutate(status)}
                  >
                    Set {METRIC_STATUS_LABEL[status].toLowerCase()}
                  </Button>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11.5px]"
                  onClick={() => setSelectedIds(new Set())}
                >
                  Clear
                </Button>
                {bulkStatusMut.isError && (
                  <span className="text-[11.5px]" style={{ color: 'var(--danger)' }}>
                    {getErrorMessage(bulkStatusMut.error)}
                  </span>
                )}
              </div>
            )}
            {metricsQuery.isLoading ? (
              <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                Loading…
              </div>
            ) : visibleMetrics.length === 0 ? (
              <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                No metrics match the current filters.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div role="table" aria-label="Metrics" className="min-w-[748px]">
                  <div role="rowgroup">
                    <div
                      role="row"
                      className={`${METRIC_GRID} border-b py-2 text-[10.5px] font-semibold uppercase tracking-[0.05em]`}
                      style={{ borderColor: 'var(--border-subtle)', color: 'var(--fg-faint)' }}
                    >
                      <span role="columnheader" aria-label="Reorder" />
                      <span role="columnheader">
                        <Checkbox
                          aria-label="Select all metrics"
                          checked={allSelected}
                          onCheckedChange={toggleAll}
                        />
                      </span>
                      <span role="columnheader">Metric</span>
                      <span role="columnheader">Latest</span>
                      <span role="columnheader">
                        {trendPoints > 0 ? `Trend · ${trendPoints} pts` : 'Trend'}
                      </span>
                      <span role="columnheader">Status</span>
                      <span role="columnheader" className="text-right">Updated</span>
                      <span role="columnheader" aria-label="Actions" />
                    </div>
                  </div>
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={visibleMetrics.map(m => m.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div role="rowgroup">
                        {visibleMetrics.map(metric => (
                          <MetricRow
                            key={metric.id}
                            metric={metric}
                            slug={slug}
                            canReorder={canReorder}
                            existingNames={existingNames}
                            isSelected={selectedIds.has(metric.id)}
                            onToggleSelected={() => toggleSelected(metric.id)}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                </div>
              </div>
            )}
          </Panel>
        ))}
    </div>
  )
}

interface MetricRowProps {
  metric: MetricDefinitionListItem
  slug?: string
  canReorder: boolean
  existingNames: ReadonlySet<string>
  isSelected: boolean
  onToggleSelected: () => void
}

function MetricRow({
  metric,
  slug,
  canReorder,
  existingNames,
  isSelected,
  onToggleSelected,
}: MetricRowProps) {
  const navigate = useNavigate()
  const href = slug ? getMetricMonitoringPath(slug, metric.id) : undefined
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: metric.id,
    disabled: !canReorder,
  })
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

  // Latest-cell tooltip (tripl-nxk2.11): prefer the actual bucket time of the
  // latest value, then a signal's bucket, else fall back to the collection
  // cadence so the cell always carries some temporal context.
  const bucketIso = metric.latest_bucket ?? metric.latest_signal?.bucket ?? null
  const latestTitle = bucketIso
    ? `Latest point: ${formatDateTime(bucketIso)}`
    : metric.interval
      ? `Collected ${INTERVAL_LABEL[metric.interval]}`
      : undefined

  return (
    <div
      ref={setNodeRef}
      role="row"
      tabIndex={href ? 0 : undefined}
      className={`${METRIC_GRID} border-b py-2.5 last:border-0 ${
        href ? 'cursor-pointer transition-colors hover:bg-[var(--surface-hover)]' : 'cursor-default'
      }`}
      style={{
        borderColor: 'var(--border-subtle)',
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : undefined,
        position: 'relative',
        zIndex: isDragging ? 1 : undefined,
      }}
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
      <span role="cell">
        {canReorder ? (
          <button
            type="button"
            aria-label={`Reorder ${metric.display_name}`}
            className="flex cursor-grab touch-none items-center justify-center rounded p-0.5 hover:bg-[var(--surface-hover)] active:cursor-grabbing"
            style={{ color: 'var(--fg-faint)' }}
            onClick={event => event.stopPropagation()}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </span>
      <span role="cell">
        <Checkbox
          aria-label={`Select ${metric.display_name}`}
          checked={isSelected}
          onCheckedChange={onToggleSelected}
          onClick={event => event.stopPropagation()}
        />
      </span>
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
        title={latestTitle}
        className="mono truncate text-[12px]"
        style={{ color: signalTone ? `var(--${signalTone})` : 'var(--fg-subtle)' }}
      >
        {formatMetricValue(metric.latest_value, metric.unit)}
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
      <span role="cell" className="flex justify-end">
        {slug ? (
          <MetricRowMenu metric={metric} slug={slug} existingNames={existingNames} />
        ) : null}
      </span>
    </div>
  )
}

interface MetricRowMenuProps {
  metric: MetricDefinitionListItem
  slug: string
  existingNames: ReadonlySet<string>
}

/**
 * Per-row overflow (kebab) menu: Edit, Duplicate as draft, Collect now, and
 * Archive/Restore. Reuses the shared Radix DropdownMenu primitive (same one the
 * monitoring detail page uses). The trigger stops click propagation so opening
 * the menu never fires the row's navigate-on-click (mirrors the reorder handle /
 * checkbox); the menu content is portaled, so item clicks never bubble to the
 * row either.
 */
function MetricRowMenu({ metric, slug, existingNames }: MetricRowMenuProps) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const isArchived = metric.status === 'archived'

  const duplicateMut = useMutation({
    mutationFn: async () => {
      const def = await metricsCatalogApi.get(slug, metric.id)
      const name = makeCopyName(def.name, existingNames)
      const payload = buildDuplicatePayload(def, `${def.display_name} (copy)`, name)
      return metricsCatalogApi.create(slug, payload)
    },
    onSuccess: created => {
      void qc.invalidateQueries({ queryKey: ['metrics-catalog', slug] })
      toast.success('Metric duplicated as a draft.')
      navigate(`/p/${slug}/metrics/${created.id}/edit`)
    },
    onError: error => toast.error(getErrorMessage(error)),
  })

  const statusMut = useMutation({
    mutationFn: (status: MetricStatus) => metricsCatalogApi.update(slug, metric.id, { status }),
    onSuccess: (_data, status) => {
      void qc.invalidateQueries({ queryKey: ['metrics-catalog', slug] })
      toast.success(status === 'archived' ? 'Metric archived.' : 'Metric restored.')
    },
    onError: error => toast.error(getErrorMessage(error)),
  })

  const collectMut = useMutation({
    mutationFn: () => metricsCatalogApi.collect(slug, metric.id),
    onSuccess: () => toast.success('Collection queued — the chart will update shortly.'),
    onError: () => toast.error('Could not start collection.'),
  })

  const busy = duplicateMut.isPending || statusMut.isPending || collectMut.isPending

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${metric.display_name}`}
          className="flex items-center justify-center rounded p-0.5 hover:bg-[var(--surface-hover)]"
          style={{ color: 'var(--fg-faint)' }}
          onClick={event => event.stopPropagation()}
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-[184px]">
        <DropdownMenuItem
          className="text-[12.5px]"
          onSelect={() => navigate(`/p/${slug}/metrics/${metric.id}/edit`)}
        >
          <Pencil className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} /> Edit
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-[12.5px]"
          disabled={busy}
          onSelect={() => duplicateMut.mutate()}
        >
          <Copy className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} /> Duplicate as draft
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-[12.5px]"
          disabled={busy}
          onSelect={() => collectMut.mutate()}
        >
          <RefreshCw className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} /> Collect now
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-[12.5px]"
          variant={isArchived ? 'default' : 'destructive'}
          disabled={busy}
          onSelect={() => statusMut.mutate(isArchived ? 'active' : 'archived')}
        >
          {isArchived ? (
            <>
              <ArchiveRestore className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} /> Restore
            </>
          ) : (
            <>
              <Archive className="h-3.5 w-3.5 shrink-0" /> Archive
            </>
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
