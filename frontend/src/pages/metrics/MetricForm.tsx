import { useMemo, useState, type ComponentProps } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Loader2, Plus, Save } from 'lucide-react'
import { dataSourcesApi } from '@/api/dataSources'
import { eventsApi } from '@/api/events'
import { factTablesApi } from '@/api/factTablesApi'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { ErrorState } from '@/components/error-state'
import { SqlEditor } from '@/components/sql-editor'
import { useDataSourceSchema } from '@/hooks/useDataSourceSchema'
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
  METRIC_AGGREGATIONS,
  METRIC_COMPOSITIONS,
  METRIC_KIND_LABEL,
  METRIC_SCAN_INTERVALS,
  METRIC_STATUSES,
  METRIC_STATUS_LABEL,
  type DataSource,
  type EventCompositionMetricCreate,
  type EventListItem,
  type FactMetricCreate,
  type MetricAggregation,
  type MetricComposition,
  type MetricCreate,
  type MetricDefinitionResponse,
  type MetricDefinitionUpdate,
  type MetricKind,
  type MetricScanInterval,
  type MetricStatus,
  type SqlMetricCreate,
} from '@/types'
import type { FactTable, FactTableColumn } from '@/types/factTables'

// The single fact operand shape sent to the backend (numerator / denominator /
// the implicit single operand) — derived from the generated create schema so it
// stays in lock-step without a hand-written alias.
type FactOperandPayload = NonNullable<FactMetricCreate['numerator']>

const DEFAULT_COLOR = '#6366f1'

const KIND_OPTIONS: { value: MetricKind; label: string; description: string }[] = [
  {
    value: 'sql',
    label: 'SQL',
    description: 'Run a custom SQL query that returns one numeric value per bucket.',
  },
  {
    value: 'fact',
    label: 'Fact',
    description: 'Aggregate a reusable fact table (count, sum, average, ratio…).',
  },
  {
    value: 'event_composition',
    label: 'Event composition',
    description: 'Combine existing event series (single, ratio, per distinct user).',
  },
]

const AGGREGATION_LABEL: Record<MetricAggregation, string> = {
  count: 'Count',
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
  count_distinct: 'Count distinct',
}

const FACT_COMPOSITIONS = ['single', 'ratio'] as const
type FactComposition = (typeof FACT_COMPOSITIONS)[number]

// One side of a fact metric (the single operand, or the numerator / denominator
// of a ratio). Held flat in form state and mapped to {@link FactOperandPayload}
// at submit time.
interface FactOperandState {
  factTableId: string
  aggregation: MetricAggregation
  measureColumn: string
  distinctColumn: string
  // Named filters defined on the fact table, all combined with AND, plus an
  // optional free-text WHERE fragment ANDed on top.
  rowFilters: string[]
  filterSql: string
}

const EMPTY_OPERAND: FactOperandState = {
  factTableId: '',
  aggregation: 'count',
  measureColumn: '',
  distinctColumn: '',
  rowFilters: [],
  filterSql: '',
}

// Read a string[] from an untrusted config value, with back-compat for the
// legacy single `row_filter` string.
function readRowFilters(rowFilters: unknown, legacy: string): string[] {
  if (Array.isArray(rowFilters)) {
    return rowFilters.filter((value): value is string => typeof value === 'string')
  }
  return legacy ? [legacy] : []
}

// Backend required-field rules per aggregation: sum/avg/min/max measure a
// column; count_distinct counts the distinct values of a column; count needs
// neither.
function needsMeasure(aggregation: MetricAggregation): boolean {
  return (
    aggregation === 'sum' ||
    aggregation === 'avg' ||
    aggregation === 'min' ||
    aggregation === 'max'
  )
}

function needsDistinct(aggregation: MetricAggregation): boolean {
  return aggregation === 'count_distinct'
}

// The slice of a loaded fact table the operand editor needs: its columns plus
// the identifier columns / named row filters used to populate the dropdowns.
interface FactTableDetail {
  columns: FactTableColumn[]
  identifierColumns: string[]
  rowFilters: string[]
}

const EMPTY_DETAIL: FactTableDetail = { columns: [], identifierColumns: [], rowFilters: [] }

function toDetail(table: FactTable | undefined): FactTableDetail {
  if (!table) return EMPTY_DETAIL
  return {
    columns: table.columns,
    identifierColumns: table.identifier_columns,
    rowFilters: table.row_filters.map(filter => filter.name),
  }
}

function isMetricAggregation(value: unknown): value is MetricAggregation {
  return METRIC_AGGREGATIONS.includes(value as MetricAggregation)
}

// Hydrate one operand from a stored fact-metric config sub-object (ratio
// denominator); untrusted JSON, so every field is narrowed before use.
function readOperandFromConfig(raw: unknown): FactOperandState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_OPERAND }
  const obj = raw as Record<string, unknown>
  const str = (key: string): string => (typeof obj[key] === 'string' ? (obj[key] as string) : '')
  const aggregation = obj['aggregation']
  return {
    factTableId: str('fact_table_id'),
    aggregation: isMetricAggregation(aggregation) ? aggregation : 'count',
    measureColumn: str('measure_column'),
    distinctColumn: str('distinct_column'),
    rowFilters: readRowFilters(obj['row_filters'], str('row_filter')),
    filterSql: str('filter_sql'),
  }
}

function toOperandPayload(operand: FactOperandState): FactOperandPayload {
  return {
    fact_table_id: operand.factTableId,
    aggregation: operand.aggregation,
    measure_column: needsMeasure(operand.aggregation) ? operand.measureColumn || null : null,
    distinct_column: needsDistinct(operand.aggregation) ? operand.distinctColumn || null : null,
    row_filters: operand.rowFilters,
    filter_sql: operand.filterSql.trim() || null,
  }
}

// Validate one operand against the backend required-field rules. `prefix` names
// the side for ratio operands ('numerator' / 'denominator'); empty for a single
// operand.
function operandErrors(operand: FactOperandState, prefix: string): string[] {
  const errs: string[] = []
  const qualifier = prefix ? `${prefix} ` : ''
  if (!operand.factTableId) {
    errs.push(prefix ? `A ${prefix} fact table is required.` : 'A fact table is required for a fact metric.')
  }
  if (needsMeasure(operand.aggregation) && !operand.measureColumn) {
    errs.push(`A ${qualifier}measure column is required for the ${operand.aggregation} aggregation.`)
  }
  if (needsDistinct(operand.aggregation) && !operand.distinctColumn) {
    errs.push(`A ${qualifier}distinct column is required for the count_distinct aggregation.`)
  }
  return errs
}

interface FactOperandEditorProps {
  idPrefix: string
  operand: FactOperandState
  onChange: (next: FactOperandState) => void
  factTableOptions: SelectOption[]
  detail: FactTableDetail
  loading: boolean
}

/**
 * Point-and-click editor for one fact operand: pick the fact table, the
 * aggregation, the measure/distinct column it requires, and an optional named
 * row filter. The column / row-filter dropdowns are populated from the loaded
 * fact table; for `count_distinct`, identifier columns are surfaced first.
 */
function FactOperandEditor({
  idPrefix,
  operand,
  onChange,
  factTableOptions,
  detail,
  loading,
}: FactOperandEditorProps) {
  const set = <K extends keyof FactOperandState>(key: K, value: FactOperandState[K]): void =>
    onChange({ ...operand, [key]: value })

  const columnOptions = useMemo(
    () =>
      toOptions(
        'Select column…',
        detail.columns.map(column => ({ value: column.name, label: `${column.name} · ${column.type}` })),
      ),
    [detail.columns],
  )

  // Prefer identifier columns for count_distinct, but still allow any column.
  const distinctOptions = useMemo(() => {
    const identifiers = new Set(detail.identifierColumns)
    const ordered = [
      ...detail.columns.filter(column => identifiers.has(column.name)),
      ...detail.columns.filter(column => !identifiers.has(column.name)),
    ]
    return toOptions(
      'Select column…',
      ordered.map(column => ({
        value: column.name,
        label: identifiers.has(column.name) ? `${column.name} · id` : column.name,
      })),
    )
  }, [detail.columns, detail.identifierColumns])

  const toggleRowFilter = (name: string): void =>
    set(
      'rowFilters',
      operand.rowFilters.includes(name)
        ? operand.rowFilters.filter(n => n !== name)
        : [...operand.rowFilters, name],
    )

  const columnHint = loading ? 'Loading columns…' : undefined

  return (
    <>
      <MField label="Fact table" htmlFor={`${idPrefix}-table`} required>
        <Select
          id={`${idPrefix}-table`}
          value={operand.factTableId}
          onChange={value => set('factTableId', value)}
          options={factTableOptions}
          aria-required
        />
      </MField>
      <MField label="Aggregation" htmlFor={`${idPrefix}-aggregation`} required>
        <Select
          id={`${idPrefix}-aggregation`}
          value={operand.aggregation}
          onChange={value => set('aggregation', value as MetricAggregation)}
          options={METRIC_AGGREGATIONS.map(a => ({ value: a, label: AGGREGATION_LABEL[a] }))}
        />
      </MField>
      {needsMeasure(operand.aggregation) && (
        <MField
          label="Measure column"
          htmlFor={`${idPrefix}-measure`}
          required
          hint={columnHint ?? 'Column to aggregate (numeric preferred).'}
        >
          <Select
            id={`${idPrefix}-measure`}
            value={operand.measureColumn}
            onChange={value => set('measureColumn', value)}
            options={columnOptions}
            disabled={!operand.factTableId}
            aria-required
          />
        </MField>
      )}
      {needsDistinct(operand.aggregation) && (
        <MField
          label="Distinct column"
          htmlFor={`${idPrefix}-distinct`}
          required
          hint={columnHint ?? 'Column whose distinct values are counted.'}
        >
          <Select
            id={`${idPrefix}-distinct`}
            value={operand.distinctColumn}
            onChange={value => set('distinctColumn', value)}
            options={distinctOptions}
            disabled={!operand.factTableId}
            aria-required
          />
        </MField>
      )}
      {detail.rowFilters.length > 0 && (
        <MField
          label="Named filters"
          htmlFor={`${idPrefix}-row-filters`}
          hint="Named filters defined on the fact table. All selected ones are combined with AND."
        >
          <div id={`${idPrefix}-row-filters`} className="flex flex-col gap-1.5">
            {detail.rowFilters.map(name => (
              <label key={name} className="flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--fg)' }}>
                <input
                  type="checkbox"
                  checked={operand.rowFilters.includes(name)}
                  onChange={() => toggleRowFilter(name)}
                  disabled={!operand.factTableId}
                  aria-label={`Apply the ${name} row filter`}
                />
                <span className="mono">{name}</span>
              </label>
            ))}
          </div>
        </MField>
      )}
      <MField
        label="Filter (SQL)"
        htmlFor={`${idPrefix}-filter-sql`}
        last
        hint="Optional raw WHERE condition, combined with AND. Write SQL directly — no need to predefine a named filter."
      >
        <TextInput
          id={`${idPrefix}-filter-sql`}
          value={operand.filterSql}
          onChange={value => set('filterSql', value)}
          mono
          placeholder="status = 'completed' AND amount > 0"
          disabled={!operand.factTableId}
        />
      </MField>
    </>
  )
}

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

// Derive a snake_case identifier from a display name: lower-case, runs of
// non-alphanumerics collapsed to single underscores, trimmed. Used to pre-fill
// the internal name as the user types the display name.
function toSnakeCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
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
  // Tracks whether the user has typed the internal name directly; once they
  // have, we stop auto-deriving it from the display name.
  const [nameEdited, setNameEdited] = useState(false)
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

  // Fact metric. The single operand reuses `numeratorOp`; ratio adds `denominatorOp`.
  const [factComposition, setFactComposition] = useState<FactComposition>(
    metric?.kind === 'fact' && metric.composition === 'ratio' ? 'ratio' : 'single',
  )
  const [numeratorOp, setNumeratorOp] = useState<FactOperandState>(() => ({
    factTableId: metric?.fact_table_id ?? '',
    aggregation: metric?.aggregation ?? 'count',
    measureColumn: configString('measure_column'),
    distinctColumn: configString('distinct_column'),
    rowFilters: readRowFilters(initialConfig['row_filters'], configString('row_filter')),
    filterSql: configString('filter_sql'),
  }))
  const [denominatorOp, setDenominatorOp] = useState<FactOperandState>(() =>
    readOperandFromConfig(initialConfig['denominator']),
  )

  const [formErrors, setFormErrors] = useState<string[]>([])

  const factEnabled = isNew && kind === 'fact'
  const factTablesQuery = useQuery({
    queryKey: ['fact-tables', slug],
    queryFn: () => factTablesApi.list(slug),
    enabled: factEnabled,
  })
  const numeratorDetailQuery = useQuery({
    queryKey: ['fact-table', slug, numeratorOp.factTableId],
    queryFn: () => factTablesApi.get(slug, numeratorOp.factTableId),
    enabled: factEnabled && !!numeratorOp.factTableId,
  })
  const denominatorDetailQuery = useQuery({
    queryKey: ['fact-table', slug, denominatorOp.factTableId],
    queryFn: () => factTablesApi.get(slug, denominatorOp.factTableId),
    enabled: factEnabled && factComposition === 'ratio' && !!denominatorOp.factTableId,
  })

  const factTableOptions = useMemo(
    () =>
      toOptions(
        'Select fact table…',
        (factTablesQuery.data?.items ?? []).map(t => ({ value: t.id, label: t.display_name })),
      ),
    [factTablesQuery.data],
  )
  const numeratorDetail = useMemo(() => toDetail(numeratorDetailQuery.data), [numeratorDetailQuery.data])
  const denominatorDetail = useMemo(
    () => toDetail(denominatorDetailQuery.data),
    [denominatorDetailQuery.data],
  )
  const hasFactTables = (factTablesQuery.data?.items.length ?? 0) > 0

  const dataSourceOptions = useMemo(
    () => toOptions('Select data source…', dataSources.map(ds => ({ value: ds.id, label: ds.name }))),
    [dataSources],
  )
  const eventOptions = useMemo(
    () => toOptions('Select event…', events.map(e => ({ value: e.id, label: e.name }))),
    [events],
  )

  // Drive the SQL editor's dialect highlighting + schema-aware autocomplete from
  // the selected data source (same wiring as the scans base-query editor).
  const selectedDataSource = useMemo(
    () => dataSources.find(ds => ds.id === dataSourceId),
    [dataSources, dataSourceId],
  )
  const { data: sqlSchemaData } = useDataSourceSchema(dataSourceId || undefined)

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
        if (!metricSql.trim()) errs.push('The metric SQL query is required.')
        if (!sqlTimeColumn.trim()) errs.push('A time column is required for a SQL metric.')
      } else if (kind === 'fact') {
        if (factComposition === 'ratio') {
          errs.push(...operandErrors(numeratorOp, 'numerator'))
          errs.push(...operandErrors(denominatorOp, 'denominator'))
        } else {
          errs.push(...operandErrors(numeratorOp, ''))
        }
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
      if (factComposition === 'ratio') {
        const payload: FactMetricCreate = {
          ...base,
          kind: 'fact',
          composition: 'ratio',
          interval,
          numerator: toOperandPayload(numeratorOp),
          denominator: toOperandPayload(denominatorOp),
        }
        return payload
      }
      const payload: FactMetricCreate = {
        ...base,
        kind: 'fact',
        composition: 'single',
        interval,
        fact_table_id: numeratorOp.factTableId,
        aggregation: numeratorOp.aggregation,
        measure_column: needsMeasure(numeratorOp.aggregation)
          ? numeratorOp.measureColumn || null
          : null,
        distinct_column: needsDistinct(numeratorOp.aggregation)
          ? numeratorOp.distinctColumn || null
          : null,
        row_filters: numeratorOp.rowFilters,
        filter_sql: numeratorOp.filterSql.trim() || null,
      }
      return payload
    }
    if (kind === 'event_composition') {
      const payload: EventCompositionMetricCreate = {
        ...base,
        kind: 'event_composition',
        composition,
        numerator_event_id: numeratorEventId || null,
        denominator_event_id: composition === 'ratio' ? denominatorEventId || null : null,
      }
      return payload
    }
    // Exhaustiveness guard: a future MetricKind must add a branch above. Missing
    // one fails at compile time (the `never` assignment) and loudly at runtime,
    // rather than silently producing a wrong-kind payload.
    const _exhaustive: never = kind
    throw new Error(`unsupported metric kind: ${String(_exhaustive)}`)
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

  const onDisplayNameChange = (value: string) => {
    setDisplayName(value)
    // Pre-fill the internal name from the display name until the user edits it
    // directly (creation only — the internal name is immutable afterwards).
    if (isNew && !nameEdited) setName(toSnakeCase(value))
  }
  const onInternalNameChange = (value: string) => {
    setNameEdited(true)
    setName(value)
  }

  return (
    <div className="h-full overflow-y-auto">
      <form
        onSubmit={e => {
          e.preventDefault()
          onSubmit()
        }}
        className="mx-auto max-w-[1100px] px-6 pb-12 pt-4"
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

        {/* Top row: Details on the left, Kind + its primary config on the right
            (roughly matched heights, full page width). */}
        <div className="grid grid-cols-1 gap-x-5 lg:grid-cols-2">
          <div>
            <SCard title="Details">
              <MField label="Display name" htmlFor="metric-display-name" required>
                <TextInput id="metric-display-name" value={displayName} onChange={onDisplayNameChange} placeholder="Checkout conversion" aria-required />
              </MField>
              <MField
                label="Internal name"
                htmlFor={isNew ? 'metric-name' : undefined}
                required={isNew}
                hint={isNew ? 'Stable identifier used in queries.' : "Can't be changed after creation."}
              >
                {isNew ? (
                  <TextInput id="metric-name" value={name} onChange={onInternalNameChange} mono placeholder="checkout_conversion" aria-required />
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
          </div>

          <div>
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
                  <SqlEditor
                    id="metric-sql-query"
                    ariaLabel="Metric SQL"
                    value={metricSql}
                    onChange={setMetricSql}
                    placeholder="SELECT date_trunc('hour', created_at) AS bucket, count(*) AS value FROM events GROUP BY 1"
                    dialect={selectedDataSource?.db_type}
                    tables={sqlSchemaData?.tables}
                    minHeight="150px"
                  />
                </MField>
                <MField label="Time column" htmlFor="metric-sql-time" required last hint="The bucket/time column returned by the query.">
                  <TextInput id="metric-sql-time" value={sqlTimeColumn} onChange={setSqlTimeColumn} mono placeholder="bucket" />
                </MField>
              </SCard>
            )}

            {factEnabled && (
              <SCard title="Fact" description="Aggregate a reusable fact table into one value per bucket.">
                <MField
                  label="Composition"
                  htmlFor="metric-fact-composition"
                  required
                  hint="A single aggregation, or a ratio of two."
                >
                  <Select
                    id="metric-fact-composition"
                    value={factComposition}
                    onChange={value => setFactComposition(value as FactComposition)}
                    options={FACT_COMPOSITIONS.map(c => ({
                      value: c,
                      label: c === 'single' ? 'Single' : 'Ratio',
                    }))}
                  />
                </MField>
                <MField label="Collection interval" htmlFor="metric-fact-interval" required last>
                  <Select
                    id="metric-fact-interval"
                    value={interval}
                    onChange={value => setIntervalValue(value as MetricScanInterval)}
                    options={METRIC_SCAN_INTERVALS.map(i => ({ value: i, label: i }))}
                  />
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
          </div>
        </div>

        {/* Fact aggregation operands span full width below the top row: a single
            operand, or numerator | denominator side by side for a ratio. */}
        {factEnabled && (
          factTablesQuery.isSuccess && !hasFactTables ? (
            <SCard title="Aggregation">
              <div className="px-[18px] py-[15px] text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
                No fact tables yet. Define one in Fact tables before creating a fact metric.
              </div>
            </SCard>
          ) : factComposition === 'single' ? (
            <SCard title="Aggregation">
              <FactOperandEditor
                idPrefix="metric-fact"
                operand={numeratorOp}
                onChange={setNumeratorOp}
                factTableOptions={factTableOptions}
                detail={numeratorDetail}
                loading={numeratorDetailQuery.isFetching}
              />
            </SCard>
          ) : (
            <div className="grid grid-cols-1 gap-x-5 lg:grid-cols-2">
              <div>
                <SCard title="Numerator">
                  <FactOperandEditor
                    idPrefix="metric-fact-num"
                    operand={numeratorOp}
                    onChange={setNumeratorOp}
                    factTableOptions={factTableOptions}
                    detail={numeratorDetail}
                    loading={numeratorDetailQuery.isFetching}
                  />
                </SCard>
              </div>
              <div>
                <SCard title="Denominator" description="May reference a different fact table.">
                  <FactOperandEditor
                    idPrefix="metric-fact-den"
                    operand={denominatorOp}
                    onChange={setDenominatorOp}
                    factTableOptions={factTableOptions}
                    detail={denominatorDetail}
                    loading={denominatorDetailQuery.isFetching}
                  />
                </SCard>
              </div>
            </div>
          )
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
      key={metricQuery.data?.id ?? 'new'}
      slug={slug}
      metric={metricQuery.data ?? null}
      dataSources={dataSourcesQuery.data ?? EMPTY_DATA_SOURCES}
      events={eventsQuery.data?.items ?? EMPTY_EVENTS}
      onClose={goBack}
    />
  )
}
