import { useMemo, useState, type ComponentProps } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Loader2, Plus, Save } from 'lucide-react'
import { dataSourcesApi } from '@/api/dataSources'
import { eventsApi } from '@/api/events'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { ErrorState } from '@/components/error-state'
import {
  Field,
  RadioCards,
  SCard,
  Select,
  TextArea,
  TextInput,
  ToggleRow,
  type SelectOption,
} from '@/components/settings/kit'
import {
  METRIC_COMPOSITIONS,
  METRIC_KIND_LABEL,
  METRIC_SCAN_INTERVALS,
  METRIC_STATUSES,
  METRIC_STATUS_LABEL,
  type DataSource,
  type EventCompositionMetricCreate,
  type EventListItem,
  type MetricComposition,
  type MetricCreate,
  type MetricDefinitionResponse,
  type MetricDefinitionUpdate,
  type MetricKind,
  type MetricScanInterval,
  type MetricStatus,
  type SqlMetricCreate,
} from '@/types'

const DEFAULT_COLOR = '#6366f1'

const KIND_OPTIONS: { value: MetricKind; label: string; description: string }[] = [
  {
    value: 'sql',
    label: 'SQL',
    description: 'Run a custom SQL query that returns one numeric value per bucket.',
  },
  {
    value: 'event_composition',
    label: 'Event composition',
    description: 'Combine existing event series (single, ratio, per distinct user).',
  },
]

function toOptions(prefix: string, items: { value: string; label: string }[]): SelectOption[] {
  return [{ value: '', label: prefix }, ...items]
}

function splitColumns(raw: string): string[] {
  const seen = new Set<string>()
  return raw
    .split(',')
    .map(part => part.trim())
    .filter(part => {
      if (!part || seen.has(part)) return false
      seen.add(part)
      return true
    })
}

// kit's Field has no `required` flag; this thin wrapper renders the red marker
// to the right of the label (kit's `labelRight` slot) when a field is required.
function MField({ required, ...props }: { required?: boolean } & ComponentProps<typeof Field>) {
  const labelRight = required ? (
    <span style={{ color: 'var(--danger)' }}>*</span>
  ) : (
    props.labelRight
  )
  return <Field {...props} labelRight={labelRight} />
}

interface MetricFormProps {
  slug: string
  metric: MetricDefinitionResponse | null
  dataSources: DataSource[]
  events: EventListItem[]
  onClose: () => void
}

/**
 * Create / edit a catalog metric. `kind` + its config define the metric's
 * identity, so they are only editable when creating — editing exposes the
 * presentation / lifecycle / monitoring fields (mirrors the EventType update
 * surface). Client-side validation mirrors the backend discriminated-union
 * rules; server 422s surface through {@link ErrorState}.
 */
export function MetricForm({ slug, metric, dataSources, events, onClose }: MetricFormProps) {
  const qc = useQueryClient()
  const isNew = !metric

  const initialConfig = (metric?.config ?? {}) as Record<string, unknown>
  const configString = (key: string): string => {
    const value = initialConfig[key]
    return typeof value === 'string' ? value : ''
  }

  const [kind, setKind] = useState<MetricKind>(metric?.kind ?? 'sql')
  const [displayName, setDisplayName] = useState(metric?.display_name ?? '')
  const [name, setName] = useState(metric?.name ?? '')
  const [description, setDescription] = useState(metric?.description ?? '')
  const [status, setStatus] = useState<MetricStatus>(metric?.status ?? 'draft')
  const [unit, setUnit] = useState(metric?.unit ?? '')
  const [color, setColor] = useState(metric?.color ?? DEFAULT_COLOR)
  const [anomalyDetection, setAnomalyDetection] = useState(
    metric?.anomaly_detection_enabled ?? true,
  )
  const [breakdownColumns, setBreakdownColumns] = useState(
    (metric?.breakdown_columns ?? []).join(', '),
  )
  const [appVersionColumn, setAppVersionColumn] = useState(metric?.app_version_column ?? '')
  const [platformColumn, setPlatformColumn] = useState(metric?.platform_column ?? '')

  // Shared collection settings (SQL today; fact metrics arrive in a later slice).
  const [dataSourceId, setDataSourceId] = useState(metric?.data_source_id ?? '')
  const [interval, setIntervalValue] = useState<MetricScanInterval>(metric?.interval ?? '1h')

  // SQL
  const [metricSql, setMetricSql] = useState(configString('metric_sql'))
  const [sqlTimeColumn, setSqlTimeColumn] = useState(configString('time_column'))

  // Event composition
  const [composition, setComposition] = useState<MetricComposition>(metric?.composition ?? 'single')
  const [numeratorEventId, setNumeratorEventId] = useState(metric?.numerator_event_id ?? '')
  const [denominatorEventId, setDenominatorEventId] = useState(metric?.denominator_event_id ?? '')

  const [formErrors, setFormErrors] = useState<string[]>([])

  const dataSourceOptions = useMemo(
    () => toOptions('Select data source…', dataSources.map(ds => ({ value: ds.id, label: ds.name }))),
    [dataSources],
  )
  const eventOptions = useMemo(
    () => toOptions('Select event…', events.map(e => ({ value: e.id, label: e.name }))),
    [events],
  )

  function validate(): string[] {
    const errs: string[] = []
    if (!displayName.trim()) errs.push('Display name is required.')

    // `name` (identity) and the kind-specific config are immutable after
    // creation and are excluded from `buildUpdatePayload()`, so only validate
    // them when creating — otherwise an edit could be blocked by a field the
    // backend will never receive.
    if (isNew) {
      if (!name.trim()) errs.push('Internal name is required.')

      if (kind === 'sql') {
        if (!dataSourceId) errs.push('A data source is required for a SQL metric.')
        if (!interval) errs.push('A collection interval is required.')
        if (!metricSql.trim()) errs.push('The metric SQL query is required.')
        if (!sqlTimeColumn.trim()) errs.push('A time column is required for a SQL metric.')
      } else {
        if (!numeratorEventId) errs.push('A numerator event is required.')
        if (composition === 'ratio' && !denominatorEventId) {
          errs.push('A denominator event is required for a ratio metric.')
        }
      }
    }
    return errs
  }

  function buildCreatePayload(): MetricCreate {
    const base = {
      anomaly_detection_enabled: anomalyDetection,
      app_version_column: appVersionColumn.trim() || null,
      breakdown_columns: splitColumns(breakdownColumns),
      color,
      description,
      display_name: displayName.trim(),
      name: name.trim(),
      order: metric?.order ?? 0,
      platform_column: platformColumn.trim() || null,
      reviewed: metric?.reviewed ?? false,
      status,
      unit: unit.trim() || null,
    }

    // TODO(tripl-ysji.5): build the rich `fact` create payload + form here.
    if (kind === 'sql') {
      const payload: SqlMetricCreate = {
        ...base,
        kind: 'sql',
        interval,
        data_source_id: dataSourceId,
        config: {
          metric_sql: metricSql,
          time_column: sqlTimeColumn.trim(),
        },
      }
      return payload
    }
    if (kind === 'fact') {
      throw new Error('fact metric creation is not yet implemented (tripl-ysji.5)')
    }
    const payload: EventCompositionMetricCreate = {
      ...base,
      kind: 'event_composition',
      composition,
      numerator_event_id: numeratorEventId || null,
      denominator_event_id: composition === 'ratio' ? denominatorEventId || null : null,
    }
    return payload
  }

  function buildUpdatePayload(): MetricDefinitionUpdate {
    return {
      display_name: displayName.trim(),
      description,
      status,
      unit: unit.trim() || null,
      color,
      anomaly_detection_enabled: anomalyDetection,
      breakdown_columns: splitColumns(breakdownColumns),
      app_version_column: appVersionColumn.trim() || null,
      platform_column: platformColumn.trim() || null,
    }
  }

  const saveMut = useMutation({
    mutationFn: () =>
      metric
        ? metricsCatalogApi.update(slug, metric.id, buildUpdatePayload())
        : metricsCatalogApi.create(slug, buildCreatePayload()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['metrics-catalog', slug] })
      if (metric) void qc.invalidateQueries({ queryKey: ['metricDefinition', slug] })
      onClose()
    },
  })

  const onSubmit = () => {
    const errs = validate()
    setFormErrors(errs)
    if (errs.length > 0) return
    saveMut.mutate()
  }

  // Switching kind swaps which config fields render, so a stale error list would
  // show messages for fields that no longer exist. Clear it on kind change;
  // re-validation still runs on the next submit.
  const changeKind = (next: MetricKind) => {
    setKind(next)
    setFormErrors([])
  }

  return (
    <div className="h-full overflow-y-auto">
      <form
        onSubmit={e => {
          e.preventDefault()
          onSubmit()
        }}
        className="mx-auto max-w-[880px] px-6 pb-12 pt-4"
      >
        <button
          type="button"
          onClick={onClose}
          className="mb-[14px] inline-flex items-center gap-1 text-[11.5px] transition-colors hover:text-[var(--fg)]"
          style={{ color: 'var(--fg-muted)' }}
        >
          <ChevronLeft size={13} /> Metrics
        </button>
        <h1 className="mb-[18px] text-[19px] font-semibold tracking-[-0.01em]">
          {isNew ? 'New metric' : 'Edit metric'}
        </h1>

        <SCard title="Kind" description="How this metric produces its per-bucket value.">
          <MField label="Metric kind" stacked last hint={isNew ? undefined : "Can't be changed after creation."}>
            {isNew ? (
              <RadioCards
                groupLabel="Metric kind"
                value={kind}
                onChange={value => changeKind(value as MetricKind)}
                options={KIND_OPTIONS}
              />
            ) : (
              <div className="text-[13px] font-medium" style={{ color: 'var(--fg)' }}>
                {METRIC_KIND_LABEL[kind]}
              </div>
            )}
          </MField>
        </SCard>

        <SCard title="Details">
          <MField label="Display name" htmlFor="metric-display-name" required>
            <TextInput id="metric-display-name" value={displayName} onChange={setDisplayName} placeholder="Checkout conversion" />
          </MField>
          <MField
            label="Internal name"
            htmlFor={isNew ? 'metric-name' : undefined}
            required={isNew}
            hint={isNew ? 'Stable identifier used in queries.' : "Can't be changed after creation."}
          >
            {isNew ? (
              <TextInput id="metric-name" value={name} onChange={setName} mono placeholder="checkout_conversion" />
            ) : (
              <div className="mono text-[13px]" style={{ color: 'var(--fg)' }}>
                {name}
              </div>
            )}
          </MField>
          <MField label="Description" htmlFor="metric-description">
            <TextArea id="metric-description" value={description} onChange={setDescription} rows={2} placeholder="What does this metric measure?" />
          </MField>
          <MField label="Unit" htmlFor="metric-unit" hint="Optional display unit (e.g. %, ms).">
            <TextInput id="metric-unit" value={unit} onChange={setUnit} placeholder="%" />
          </MField>
          <MField label="Color" htmlFor="metric-color">
            <input
              id="metric-color"
              type="color"
              value={color}
              onChange={e => setColor(e.target.value)}
              className="h-8 w-12 cursor-pointer rounded border bg-transparent"
              style={{ borderColor: 'var(--border)' }}
            />
          </MField>
          <MField label="Status" htmlFor="metric-status" last>
            <Select
              id="metric-status"
              value={status}
              onChange={value => setStatus(value as MetricStatus)}
              options={METRIC_STATUSES.map(s => ({ value: s, label: METRIC_STATUS_LABEL[s] }))}
            />
          </MField>
        </SCard>

        {isNew && kind === 'sql' && (
          <SCard title="SQL" description="A custom query returning one numeric value per bucket.">
            <MField label="Data source" htmlFor="metric-sql-data-source" required>
              <Select id="metric-sql-data-source" value={dataSourceId} onChange={setDataSourceId} options={dataSourceOptions} />
            </MField>
            <MField label="Collection interval" htmlFor="metric-sql-interval" required>
              <Select
                id="metric-sql-interval"
                value={interval}
                onChange={value => setIntervalValue(value as MetricScanInterval)}
                options={METRIC_SCAN_INTERVALS.map(i => ({ value: i, label: i }))}
              />
            </MField>
            <MField label="Metric SQL" htmlFor="metric-sql-query" required stacked>
              <TextArea id="metric-sql-query" value={metricSql} onChange={setMetricSql} mono rows={5} placeholder="SELECT date_trunc('hour', created_at) AS bucket, count(*) AS value FROM events GROUP BY 1" />
            </MField>
            <MField label="Time column" htmlFor="metric-sql-time" required last hint="The bucket/time column returned by the query.">
              <TextInput id="metric-sql-time" value={sqlTimeColumn} onChange={setSqlTimeColumn} mono placeholder="bucket" />
            </MField>
          </SCard>
        )}

        {isNew && kind === 'event_composition' && (
          <SCard title="Event composition" description="Combine existing event series.">
            <MField label="Composition" htmlFor="metric-composition" required>
              <Select
                id="metric-composition"
                value={composition}
                onChange={value => setComposition(value as MetricComposition)}
                options={METRIC_COMPOSITIONS.map(c => ({ value: c, label: c }))}
              />
            </MField>
            <MField label="Numerator event" htmlFor="metric-numerator" required>
              <Select id="metric-numerator" value={numeratorEventId} onChange={setNumeratorEventId} options={eventOptions} />
            </MField>
            <MField
              label="Denominator event"
              htmlFor="metric-denominator"
              required={composition === 'ratio'}
              last
              hint={composition === 'ratio' ? 'Required for a ratio metric.' : 'Only used by ratio metrics.'}
            >
              <Select
                id="metric-denominator"
                value={denominatorEventId}
                onChange={setDenominatorEventId}
                options={eventOptions}
                disabled={composition !== 'ratio'}
              />
            </MField>
          </SCard>
        )}

        <SCard title="Monitoring" description="Anomaly detection and dimensional breakdowns.">
          <ToggleRow
            label="Anomaly detection"
            hint="Learn a baseline and flag spikes/drops on this metric."
            value={anomalyDetection}
            onChange={setAnomalyDetection}
          />
          <MField label="Breakdown columns" htmlFor="metric-breakdowns" hint="Comma-separated warehouse columns to roll up by.">
            <TextInput id="metric-breakdowns" value={breakdownColumns} onChange={setBreakdownColumns} mono placeholder="platform, country" />
          </MField>
          <MField label="App version column" htmlFor="metric-app-version" hint="Optional column used for by-version series.">
            <TextInput id="metric-app-version" value={appVersionColumn} onChange={setAppVersionColumn} mono placeholder="app_version" />
          </MField>
          <MField label="Platform column" htmlFor="metric-platform" last hint="Optional platform dimension column.">
            <TextInput id="metric-platform" value={platformColumn} onChange={setPlatformColumn} mono placeholder="platform" />
          </MField>
        </SCard>

        {formErrors.length > 0 && (
          <div
            role="alert"
            className="mb-[18px] rounded-[10px] border px-4 py-3 text-[12.5px]"
            style={{
              background: 'var(--danger-soft)',
              borderColor: 'color-mix(in oklab, var(--danger) 35%, var(--border))',
              color: 'var(--danger)',
            }}
          >
            <ul className="list-disc space-y-1 pl-4">
              {formErrors.map(error => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        )}

        {saveMut.isError && (
          <div className="mb-[18px]">
            <ErrorState compact title="Could not save metric" error={saveMut.error} />
          </div>
        )}

        <div className="mt-1 flex justify-end gap-[10px]">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-[7px] px-3 text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: 'var(--fg-muted)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saveMut.isPending}
            className="inline-flex h-8 items-center gap-[6px] rounded-[7px] px-3 text-[12px] font-medium disabled:opacity-60"
            style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
          >
            {saveMut.isPending ? (
              <Loader2 className="animate-spin" size={12} />
            ) : isNew ? (
              <Plus size={12} />
            ) : (
              <Save size={12} />
            )}
            {isNew ? 'Create metric' : 'Save metric'}
          </button>
        </div>
      </form>
    </div>
  )
}

const EMPTY_DATA_SOURCES: DataSource[] = []
const EMPTY_EVENTS: EventListItem[] = []

/**
 * Route wrapper: loads the data MetricForm needs (data sources, events, and —
 * when editing — the metric itself) and renders the form full-page. Reached via
 * `/p/:slug/metrics/new` and `/p/:slug/metrics/:metricId/edit`.
 */
export default function MetricEditPage() {
  const { slug, metricId } = useParams<{ slug: string; metricId?: string }>()
  const navigate = useNavigate()
  const isNew = !metricId

  const goBack = () => navigate(`/p/${slug}/metrics`)

  const dataSourcesQuery = useQuery({
    queryKey: ['data-sources'],
    queryFn: () => dataSourcesApi.list(),
  })
  const eventsQuery = useQuery({
    queryKey: ['events', slug, null],
    queryFn: () => eventsApi.list(slug!),
    enabled: !!slug,
  })
  const metricQuery = useQuery({
    queryKey: ['metricDefinition', slug, metricId],
    queryFn: () => metricsCatalogApi.get(slug!, metricId!),
    enabled: !!slug && !!metricId,
  })

  const loadError = dataSourcesQuery.error ?? eventsQuery.error ?? metricQuery.error
  if (loadError) {
    return (
      <div className="mx-auto max-w-[880px] p-6">
        <ErrorState
          title="Failed to load metric editor"
          error={loadError}
          onRetry={() => {
            void Promise.all([
              dataSourcesQuery.refetch(),
              eventsQuery.refetch(),
              ...(metricId ? [metricQuery.refetch()] : []),
            ])
          }}
        />
      </div>
    )
  }

  const isLoading =
    dataSourcesQuery.isLoading || eventsQuery.isLoading || (!isNew && metricQuery.isLoading)
  if (isLoading || !slug) {
    return (
      <div className="flex min-h-[240px] items-center justify-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
        Loading…
      </div>
    )
  }

  return (
    <MetricForm
      slug={slug}
      metric={metricQuery.data ?? null}
      dataSources={dataSourcesQuery.data ?? EMPTY_DATA_SOURCES}
      events={eventsQuery.data?.items ?? EMPTY_EVENTS}
      onClose={goBack}
    />
  )
}
