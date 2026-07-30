import { useMemo, useState, type ComponentProps } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Loader2, Play, Plus, Save } from 'lucide-react'
import { dataSourcesApi } from '@/api/dataSources'
import { eventsApi } from '@/api/events'
import { factTablesApi } from '@/api/factTablesApi'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { ColumnCheckboxPicker } from '@/components/column-checkbox-picker'
import { ColumnSuggestInput } from '@/components/column-suggest'
import { ErrorState } from '@/components/error-state'
import { Sparkline } from '@/components/primitives/sparkline'
import { SqlEditor } from '@/components/sql-editor'
import { useConfirm } from '@/hooks/useConfirm'
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
  METRIC_SCAN_INTERVALS,
  METRIC_STATUSES,
  METRIC_STATUS_LABEL,
  type DataSource,
  type EventCompositionMetricCreate,
  type EventListItem,
  type FactMetricCreate,
  type MetricDefinitionConfigUpdate,
  type MetricAggregation,
  type MetricComposition,
  type MetricCreate,
  type MetricDefinitionDetailResponse,
  type MetricDefinitionUpdate,
  type MetricKind,
  type MetricPreviewRequest,
  type MetricPreviewResponse,
  type MetricScanInterval,
  type MetricStatus,
  type SqlMetricCreate,
} from '@/types'
import type { FactTable, FactTableColumn } from '@/types/factTables'
import { FactFilterEditor } from './FactFilterEditor'
import { filtersFromConfig, filtersToPayload, type FactFilter } from './factFilters'
import {
  METRIC_TEMPLATES,
  isPristineStarterSql,
  starterSql,
  type MetricTemplate,
  type SqlTemplateId,
} from './metricTemplates'
import { dataSourcesKey } from '@/lib/queryKeys'

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

// Human-readable labels for the event-composition select (raw option values are
// kept as-is on the wire).
const COMPOSITION_LABEL: Record<MetricComposition, string> = {
  single: 'Single',
  ratio: 'Ratio',
  per_distinct_user: 'Per distinct user',
}

// Human-readable labels for the collection-interval selects. The option values
// stay the raw cron-ish tokens the backend expects.
const INTERVAL_LABEL: Record<MetricScanInterval, string> = {
  '15m': 'Every 15 min',
  '1h': 'Hourly',
  '6h': 'Every 6 h',
  '1d': 'Daily',
  '1w': 'Weekly',
}

// Scroll the first errored field into view and focus it after a failed submit.
// scrollIntoView is guarded because jsdom (tests) may not implement it.
function scrollToField(id: string): void {
  const el = document.getElementById(id)
  if (!el) return
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  if (typeof (el as HTMLElement).focus === 'function') {
    ;(el as HTMLElement).focus()
  }
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
  // An ordered list of named/SQL filters, all combined with AND.
  filters: FactFilter[]
}

const EMPTY_OPERAND: FactOperandState = {
  factTableId: '',
  aggregation: 'count',
  measureColumn: '',
  distinctColumn: '',
  filters: [],
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
    filters: filtersFromConfig(
      obj['row_filters'],
      str('row_filter'),
      str('filter_sql'),
      obj['conditions'],
    ),
  }
}

function toOperandPayload(
  operand: FactOperandState,
  conditionColumns: readonly FactTableColumn[] = [],
): FactOperandPayload {
  return {
    fact_table_id: operand.factTableId,
    aggregation: operand.aggregation,
    measure_column: needsMeasure(operand.aggregation) ? operand.measureColumn || null : null,
    distinct_column: needsDistinct(operand.aggregation) ? operand.distinctColumn || null : null,
    ...filtersToPayload(operand.filters, conditionColumns),
  }
}

// Validate one operand against the backend required-field rules. `label` names
// the side for ratio operands ('numerator' / 'denominator'); empty for a single
// operand. Keys are the DOM ids of the offending inputs (`${idPrefix}-table`
// etc.) so the caller can render inline errors and scroll to the first one.
function operandErrors(
  operand: FactOperandState,
  idPrefix: string,
  label: string,
): Record<string, string> {
  const errs: Record<string, string> = {}
  const qualifier = label ? `${label} ` : ''
  if (!operand.factTableId) {
    errs[`${idPrefix}-table`] = label
      ? `A ${label} fact table is required.`
      : 'A fact table is required for a fact metric.'
  }
  if (needsMeasure(operand.aggregation) && !operand.measureColumn) {
    errs[`${idPrefix}-measure`] = `A ${qualifier}measure column is required for the ${operand.aggregation} aggregation.`
  }
  if (needsDistinct(operand.aggregation) && !operand.distinctColumn) {
    errs[`${idPrefix}-distinct`] = `A ${qualifier}distinct column is required for the count_distinct aggregation.`
  }
  return errs
}

interface FactOperandEditorProps {
  slug: string
  idPrefix: string
  operand: FactOperandState
  onChange: (next: FactOperandState) => void
  factTableOptions: SelectOption[]
  detail: FactTableDetail
  loading: boolean
  detailError?: boolean
  // Inline validation messages keyed by input DOM id (`${idPrefix}-table` etc.).
  errors?: Record<string, string>
}

/**
 * Point-and-click editor for one fact operand: pick the fact table, the
 * aggregation, the measure/distinct column it requires, and an optional named
 * row filter. The column / row-filter dropdowns are populated from the loaded
 * fact table; for `count_distinct`, identifier columns are surfaced first.
 *
 * The operand owns its own filter dry-run ("Check filters"): it POSTs the exact
 * payload a save would send, so the backend compiles and EXECUTES the same SQL
 * the collector will. Each operand of a ratio checks independently.
 */
function FactOperandEditor({
  slug,
  idPrefix,
  operand,
  onChange,
  factTableOptions,
  detail,
  loading,
  detailError = false,
  errors,
}: FactOperandEditorProps) {
  // Stateless dry-run of this operand's compiled row filter. Warehouse/compiler
  // rejections come back as a 200 with `error` set and render inside the panel;
  // a transport failure (404 fact table, 403) lands in `checkMut.error`.
  const checkMut = useMutation({
    mutationFn: (payload: FactOperandPayload) => metricsCatalogApi.previewFactOperand(slug, payload),
  })

  // The check describes the operand it ran against, so ANY edit to the operand
  // invalidates it — cleared here, in the only place the operand changes, rather
  // than in an effect reacting to it.
  const set = <K extends keyof FactOperandState>(key: K, value: FactOperandState[K]): void => {
    checkMut.reset()
    onChange({ ...operand, [key]: value })
  }

  const checkError = checkMut.error
    ? checkMut.error instanceof Error && checkMut.error.message
      ? checkMut.error.message
      : 'The filter check could not be run.'
    : null

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

  const columnHint = loading ? 'Loading columns…' : undefined

  return (
    <>
      <MField
        label="Fact table"
        htmlFor={`${idPrefix}-table`}
        required
        error={errors?.[`${idPrefix}-table`]}
      >
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
          error={errors?.[`${idPrefix}-measure`]}
        >
          <Select
            id={`${idPrefix}-measure`}
            value={operand.measureColumn}
            onChange={value => set('measureColumn', value)}
            options={columnOptions}
            disabled={!operand.factTableId || loading || detailError}
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
          error={errors?.[`${idPrefix}-distinct`]}
        >
          <Select
            id={`${idPrefix}-distinct`}
            value={operand.distinctColumn}
            onChange={value => set('distinctColumn', value)}
            options={distinctOptions}
            disabled={!operand.factTableId || loading || detailError}
            aria-required
          />
        </MField>
      )}
      <MField
        label="Filters"
        last
        stacked
        hint="Optional. Add named filters, structured conditions, or SQL fragments; all are combined with AND."
      >
        <FactFilterEditor
          filters={operand.filters}
          onChange={filters => set('filters', filters)}
          namedOptions={detail.rowFilters}
          conditionColumns={detail.columns}
          disabled={!operand.factTableId || loading || detailError}
          // Keep the check visible but disabled while detail metadata is loading
          // (or failed): serializing before column types resolve changes numbers
          // into strings and makes the preview disagree with the eventual save.
          onCheck={
            operand.factTableId
              ? () => checkMut.mutate(toOperandPayload(operand, detail.columns))
              : undefined
          }
          checkPending={checkMut.isPending}
          checkResult={checkMut.data ?? null}
          checkError={checkError}
        />
      </MField>
    </>
  )
}

function toOptions(prefix: string, items: { value: string; label: string }[]): SelectOption[] {
  return [{ value: '', label: prefix }, ...items]
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

// kit's Field has no `required` flag or error slot; this thin wrapper renders
// the red required marker (kit's `labelRight` slot) and appends an inline error
// message beneath the control (kit's `hint` sits in the label column, so the
// error goes into the children column to read directly under the input).
function MField({
  required,
  error,
  children,
  ...props
}: { required?: boolean; error?: string } & ComponentProps<typeof Field>) {
  const labelRight = required ? (
    <span style={{ color: 'var(--danger)' }}>*</span>
  ) : (
    props.labelRight
  )
  return (
    <Field {...props} labelRight={labelRight}>
      {children}
      {error && (
        <p
          className="mt-[6px] text-[12px] leading-[1.45]"
          style={{ color: 'var(--danger)' }}
        >
          {error}
        </p>
      )}
    </Field>
  )
}

interface SqlPreviewPanelProps {
  result: MetricPreviewResponse
  color: string
}

/**
 * Compact result panel for the SQL dry-run. Expected user mistakes (bad SQL,
 * missing columns, warehouse errors) arrive as a 200 with `error` set and
 * render in the standard danger style; a successful run renders a small line
 * chart of the returned points plus a mono summary line.
 */
function SqlPreviewPanel({ result, color }: SqlPreviewPanelProps) {
  if (result.error) {
    return (
      <div
        role="alert"
        className="mt-[10px] rounded-[10px] border px-4 py-3 text-[12.5px]"
        style={{
          background: 'var(--danger-soft)',
          borderColor: 'color-mix(in oklab, var(--danger) 35%, var(--border))',
          color: 'var(--danger)',
        }}
      >
        {result.error}
      </div>
    )
  }
  const points = result.points ?? []
  const columns = result.columns ?? []
  const summary = `${result.point_count} buckets · columns: ${columns.join(', ')}${
    result.truncated ? ' · truncated' : ''
  }`
  return (
    <div
      className="mt-[10px] rounded-[10px] border px-4 py-3"
      style={{ borderColor: 'var(--border)' }}
    >
      {points.length > 1 && (
        <div className="mb-[8px] overflow-x-auto">
          <Sparkline data={points.map(p => p.value)} color={color} width={560} height={64} />
        </div>
      )}
      <p className="mono text-[12px]" style={{ color: 'var(--fg-muted)' }}>
        {summary}
      </p>
    </div>
  )
}

interface TemplateGalleryProps {
  onPick: (template: MetricTemplate) => void
  onSkip: () => void
}

/**
 * Create-only starter gallery: a compact grid of metric templates that prefill
 * the form, plus a "Start from scratch" escape hatch. Cards are plain buttons
 * (keyboard-focusable) styled to match the RadioCards / SCard idiom; picking one
 * seeds the form and dismisses the gallery, leaving every field editable.
 */
function TemplateGallery({ onPick, onSkip }: TemplateGalleryProps) {
  return (
    <SCard
      title="Start from a template"
      description="Prefill the form for a common metric, then point it at your data — or start from scratch."
    >
      <div className="px-[18px] py-4">
        <div
          role="group"
          aria-label="Metric templates"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
        >
          {METRIC_TEMPLATES.map(template => {
            const Icon = template.icon
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => onPick(template)}
                className="flex items-start gap-2.5 rounded-[9px] px-[13px] py-[11px] text-left transition-colors hover:bg-[var(--surface-hover)]"
                style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}
              >
                <span
                  className="mt-px flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-lg"
                  style={{
                    background: 'var(--bg-sunken)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--fg-muted)',
                  }}
                >
                  <Icon size={15} />
                </span>
                <span className="min-w-0">
                  <span
                    className="block text-[12.5px] font-semibold"
                    style={{ color: 'var(--fg)' }}
                  >
                    {template.label}
                  </span>
                  <span
                    className="mt-0.5 block text-[11.5px] leading-[1.4]"
                    style={{ color: 'var(--fg-subtle)' }}
                  >
                    {template.description}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        <div className="mt-[14px]">
          <button
            type="button"
            onClick={onSkip}
            className="inline-flex h-8 items-center rounded-[7px] px-3 text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
            style={{ border: '1px solid var(--border)', color: 'var(--fg-muted)' }}
          >
            Start from scratch
          </button>
        </div>
      </div>
    </SCard>
  )
}

interface MetricFormProps {
  slug: string
  metric: MetricDefinitionDetailResponse | null
  dataSources: DataSource[]
  events: EventListItem[]
  onClose: () => void
}

/**
 * Create / edit a catalog metric. The internal name remains immutable after
 * creation, while kind + collection config can be redefined through the
 * update `definition` block. Client-side validation mirrors the backend
 * discriminated-union rules; server 422s surface through {@link ErrorState}.
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
  const [breakdownColumns, setBreakdownColumns] = useState<string[]>(
    metric?.breakdown_columns ?? [],
  )
  const [appVersionColumn, setAppVersionColumn] = useState(metric?.app_version_column ?? '')
  const [platformColumn, setPlatformColumn] = useState(metric?.platform_column ?? '')

  // Shared collection settings (SQL today; fact metrics arrive in a later slice).
  const [dataSourceId, setDataSourceId] = useState(metric?.data_source_id ?? '')
  const [interval, setIntervalValue] = useState<MetricScanInterval>(metric?.interval ?? '1h')
  const replayChunkInterval =
    metric?.kind === kind ? metric.replay_chunk_interval ?? null : null

  // SQL
  const [metricSql, setMetricSql] = useState(configString('metric_sql'))
  // Which starter scaffold seeded the SQL, if any. Non-null only while the SQL is
  // still template output; it is what lets a data-source switch re-render the
  // query for the newly-selected warehouse (see the effect below).
  const [sqlTemplateId, setSqlTemplateId] = useState<SqlTemplateId | null>(null)
  const [sqlTimeColumn, setSqlTimeColumn] = useState(configString('time_column'))
  const [sqlValueColumn, setSqlValueColumn] = useState(configString('value_column'))
  // Last SQL dry-run result. Transient client state: any edit to an input the
  // preview ran against (data source, SQL, time/value column) clears it via the
  // onChange handlers below so a stale chart never sits beside a changed query.
  const [preview, setPreview] = useState<MetricPreviewResponse | null>(null)

  // Event composition
  const [composition, setComposition] = useState<MetricComposition>(metric?.composition ?? 'single')
  const [userIdColumn, setUserIdColumn] = useState(configString('user_id_column'))
  const [numeratorEventId, setNumeratorEventId] = useState(metric?.numerator_event_id ?? '')
  const [denominatorEventId, setDenominatorEventId] = useState(metric?.denominator_event_id ?? '')
  const [numeratorEventTypeId, setNumeratorEventTypeId] = useState(
    metric?.numerator_event_type_id ?? '',
  )
  const [denominatorEventTypeId, setDenominatorEventTypeId] = useState(
    metric?.denominator_event_type_id ?? '',
  )

  // Fact metric. The single operand reuses `numeratorOp`; ratio adds `denominatorOp`.
  const [factComposition, setFactComposition] = useState<FactComposition>(
    metric?.kind === 'fact' && metric.composition === 'ratio' ? 'ratio' : 'single',
  )
  const [numeratorOp, setNumeratorOp] = useState<FactOperandState>(() => {
    const singleOperand = {
      factTableId: metric?.fact_table_id ?? '',
      aggregation: metric?.aggregation ?? 'count',
      measureColumn: configString('measure_column'),
      distinctColumn: configString('distinct_column'),
      filters: filtersFromConfig(
        initialConfig['row_filters'],
        configString('row_filter'),
        configString('filter_sql'),
        initialConfig['conditions'],
      ),
    }
    if (metric?.kind === 'fact' && metric.composition === 'ratio') {
      const ratioNumerator = readOperandFromConfig(initialConfig['numerator'])
      return ratioNumerator.factTableId ? ratioNumerator : singleOperand
    }
    return singleOperand
  })
  const [denominatorOp, setDenominatorOp] = useState<FactOperandState>(() =>
    readOperandFromConfig(initialConfig['denominator']),
  )

  // Inline validation messages keyed by the offending input's DOM id; the same
  // record drives both the per-field errors and the bottom summary list.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const { confirm: confirmKind, dialog: kindDialog } = useConfirm()

  // Create-only starter gallery: shown pristine above the form; picking a
  // template or "Start from scratch" dismisses it. Never shown when editing.
  const [showTemplates, setShowTemplates] = useState(isNew)

  const factEnabled = kind === 'fact'
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
  const numeratorDetailLoading =
    factEnabled && !!numeratorOp.factTableId && numeratorDetailQuery.isPending
  const denominatorDetailLoading =
    factEnabled
    && factComposition === 'ratio'
    && !!denominatorOp.factTableId
    && denominatorDetailQuery.isPending
  const factDetailLoading = numeratorDetailLoading || denominatorDetailLoading
  const factDetailError = factEnabled
    ? numeratorDetailQuery.error
      ?? (factComposition === 'ratio' ? denominatorDetailQuery.error : null)
    : null
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
  const selectedDbType = selectedDataSource?.db_type

  // Unique column names across every table of the selected data source, in
  // schema order — feeds the column-name comboboxes (time/value column,
  // breakdowns, app version, platform). Empty until a source is picked, which
  // leaves those inputs behaving as plain text.
  const schemaColumns = useMemo(() => {
    const seen = new Set<string>()
    const names: string[] = []
    for (const table of sqlSchemaData?.tables ?? []) {
      for (const column of table.columns) {
        if (seen.has(column.name)) continue
        seen.add(column.name)
        names.push(column.name)
      }
    }
    return names
  }, [sqlSchemaData])

  // Columns offered in the breakdown picker. Fact metrics have no data source,
  // so their columns come from the (numerator) fact table's introspected
  // schema; SQL metrics use the data-source schema union above.
  const breakdownColumnChoices = useMemo(
    () => (kind === 'fact' ? numeratorDetail.columns.map(column => column.name) : schemaColumns),
    [kind, numeratorDetail, schemaColumns],
  )

  // Field-keyed validation: each entry maps an input DOM id to its message.
  // Insertion order is top-to-bottom so the first key is the first offending
  // field to scroll to.
  function validate(): Record<string, string> {
    const errs: Record<string, string> = {}
    if (!displayName.trim()) errs['metric-display-name'] = 'Display name is required.'

    if (isNew && !name.trim()) errs['metric-name'] = 'Internal name is required.'

    if (kind === 'sql') {
      if (!dataSourceId) errs['metric-sql-data-source'] = 'A data source is required for a SQL metric.'
      if (!metricSql.trim()) errs['metric-sql-query'] = 'The metric SQL query is required.'
      if (!sqlTimeColumn.trim()) errs['metric-sql-time'] = 'A time column is required for a SQL metric.'
    } else if (kind === 'fact') {
      if (factComposition === 'ratio') {
        Object.assign(errs, operandErrors(numeratorOp, 'metric-fact-num', 'numerator'))
        Object.assign(errs, operandErrors(denominatorOp, 'metric-fact-den', 'denominator'))
      } else {
        Object.assign(errs, operandErrors(numeratorOp, 'metric-fact', ''))
      }
    } else {
      if (!numeratorEventId && !numeratorEventTypeId) {
        errs['metric-numerator'] =
          composition === 'ratio' ? 'A numerator event is required.' : 'An event is required.'
      }
      if (
        composition === 'ratio' &&
        !denominatorEventId &&
        !denominatorEventTypeId
      ) {
        errs['metric-denominator'] = 'A denominator event is required for a ratio metric.'
      }
    }
    return errs
  }

  function buildDefinitionPayload(): MetricDefinitionConfigUpdate {
    if (kind === 'sql') {
      return {
        kind: 'sql',
        interval,
        data_source_id: dataSourceId,
        config: {
          metric_sql: metricSql,
          time_column: sqlTimeColumn.trim(),
          value_column: sqlValueColumn.trim() || null,
        },
        replay_chunk_interval: replayChunkInterval,
      }
    }
    if (kind === 'fact') {
      if (factComposition === 'ratio') {
        return {
          kind: 'fact',
          composition: 'ratio',
          interval,
          numerator: toOperandPayload(numeratorOp, numeratorDetail.columns),
          denominator: toOperandPayload(denominatorOp, denominatorDetail.columns),
          replay_chunk_interval: replayChunkInterval,
        }
      }
      return {
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
        replay_chunk_interval: replayChunkInterval,
        ...filtersToPayload(numeratorOp.filters, numeratorDetail.columns),
      }
    }
    if (kind === 'event_composition') {
      return {
        kind: 'event_composition',
        composition,
        numerator_event_id: numeratorEventId || null,
        numerator_event_type_id: numeratorEventId ? null : numeratorEventTypeId || null,
        denominator_event_id: composition === 'ratio' ? denominatorEventId || null : null,
        denominator_event_type_id:
          composition === 'ratio' && !denominatorEventId
            ? denominatorEventTypeId || null
            : null,
        user_id_column:
          composition === 'per_distinct_user' ? userIdColumn.trim() || null : null,
      }
    }
    const _exhaustive: never = kind
    throw new Error(`unsupported metric kind: ${String(_exhaustive)}`)
  }

  function buildCreatePayload(): MetricCreate {
    const base = {
      anomaly_detection_enabled: anomalyDetection,
      app_version_column: appVersionColumn.trim() || null,
      // Chips are trimmed/deduped as they are added, so the state array is
      // already the exact string[] the payload expects.
      breakdown_columns: breakdownColumns,
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
          value_column: sqlValueColumn.trim() || null,
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
          numerator: toOperandPayload(numeratorOp, numeratorDetail.columns),
          denominator: toOperandPayload(denominatorOp, denominatorDetail.columns),
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
        ...filtersToPayload(numeratorOp.filters, numeratorDetail.columns),
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
        user_id_column:
          composition === 'per_distinct_user' ? userIdColumn.trim() || null : null,
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
      breakdown_columns: breakdownColumns,
      app_version_column: appVersionColumn.trim() || null,
      platform_column: platformColumn.trim() || null,
      definition: buildDefinitionPayload(),
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
      void qc.invalidateQueries({ queryKey: ['metric-generated-sql', slug] })
      onClose()
    },
  })

  // Stateless dry-run of the current SQL config against the warehouse. User
  // mistakes come back as 200 with `error` set and render inside the result
  // panel; transport failures / unknown data source (404) land in
  // `previewMut.error` and render through ErrorState like the save path.
  const previewMut = useMutation({
    mutationFn: (payload: MetricPreviewRequest) => metricsCatalogApi.preview(slug, payload),
    onSuccess: result => setPreview(result),
  })

  const canPreview =
    !!dataSourceId && !!metricSql.trim() && !!sqlTimeColumn.trim() && !previewMut.isPending

  const onPreview = () => {
    setPreview(null)
    previewMut.mutate({
      data_source_id: dataSourceId,
      sql: metricSql,
      time_column: sqlTimeColumn.trim(),
      value_column: sqlValueColumn.trim() || null,
      interval,
    })
  }

  // The preview snapshot only describes the inputs it ran against; editing any
  // of them invalidates it. Clearing happens inline in these handlers (not a
  // set-state effect) before delegating to the plain setters.
  const resetPreview = () => {
    setPreview(null)
    previewMut.reset()
  }
  /**
   * Selecting a warehouse re-renders starter SQL for it.
   *
   * The starter query is dialect-specific — `toStartOfInterval` on ClickHouse,
   * `date_bin` on PostgreSQL, `TIMESTAMP_TRUNC` on BigQuery — so SQL seeded before a
   * source was picked (or picked for a *different* source) simply cannot run on this
   * one. Regenerating here, in the handler for the only event that changes the source,
   * keeps the causality explicit; an effect reacting to `db_type` would say the same
   * thing less directly (and trips `react-hooks/set-state-in-effect`).
   *
   * It regenerates ONLY while the SQL is still pristine template output.
   * `isPristineStarterSql` goes false the moment the user edits a single character, so
   * a hand-written query is NEVER silently clobbered — being handed a stale-dialect
   * starter is a small annoyance; losing your own SQL is not.
   */
  const onDataSourceChange = (value: string) => {
    setDataSourceId(value)
    const nextDbType = dataSources.find(ds => ds.id === value)?.db_type
    if (sqlTemplateId !== null && isPristineStarterSql(sqlTemplateId, metricSql)) {
      setMetricSql(starterSql(sqlTemplateId, nextDbType))
    }
    resetPreview()
  }
  const onMetricSqlChange = (value: string) => {
    setMetricSql(value)
    resetPreview()
  }
  const onSqlTimeColumnChange = (value: string) => {
    setSqlTimeColumn(value)
    resetPreview()
  }
  const onSqlValueColumnChange = (value: string) => {
    setSqlValueColumn(value)
    resetPreview()
  }

  const onSubmit = () => {
    if (factDetailLoading || factDetailError) return
    const errs = validate()
    setFieldErrors(errs)
    const firstKey = Object.keys(errs)[0]
    if (firstKey) {
      scrollToField(firstKey)
      return
    }
    saveMut.mutate()
  }

  // Switching kind swaps which config fields render, so a stale error list would
  // show messages for fields that no longer exist. Clear it on kind change;
  // re-validation still runs on the next submit.
  const applyKind = (next: MetricKind) => {
    setKind(next)
    setFieldErrors({})
  }
  // On edit, switching to a kind other than the saved one discards the metric's
  // collected values server-side, so confirm first. Creating (or switching back
  // to the saved kind) applies immediately.
  const changeKind = (next: MetricKind) => {
    if (next === kind) return
    if (isNew || !metric || next === metric.kind) {
      applyKind(next)
      return
    }
    void confirmKind({
      title: 'Change metric kind?',
      message: "Changing the kind clears this metric's collected values. Continue?",
      variant: 'danger',
      confirmLabel: 'Change kind',
    }).then(ok => {
      if (ok) applyKind(next)
    })
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
  const onNumeratorEventChange = (value: string) => {
    setNumeratorEventId(value)
    if (value) setNumeratorEventTypeId('')
  }
  const onDenominatorEventChange = (value: string) => {
    setDenominatorEventId(value)
    if (value) setDenominatorEventTypeId('')
  }

  // Seed the create form from a starter template, then reveal the (now
  // prefilled) form. Only editable presentation + kind-shape fields are set;
  // project-specific refs (data source, fact table, events, columns) stay empty
  // so the user still points the metric at their own data.
  const applyTemplate = (template: MetricTemplate) => {
    const { seed } = template
    applyKind(seed.kind)
    onDisplayNameChange(seed.displayName)
    setUnit(seed.unit)
    setAnomalyDetection(seed.anomalyDetection)
    if (seed.interval) setIntervalValue(seed.interval)
    if (seed.composition) setComposition(seed.composition)
    if (seed.factComposition) setFactComposition(seed.factComposition)
    if (seed.aggregation) {
      const aggregation = seed.aggregation
      setNumeratorOp(prev => ({ ...prev, aggregation }))
    }
    if (seed.sqlTemplate !== undefined) {
      // Render for whatever source is selected right now (usually none, on the
      // create screen); the effect above re-renders it as soon as one is picked.
      setSqlTemplateId(seed.sqlTemplate)
      setMetricSql(starterSql(seed.sqlTemplate, selectedDbType))
    }
    if (seed.sqlTimeColumn !== undefined) setSqlTimeColumn(seed.sqlTimeColumn)
    setShowTemplates(false)
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
        <h1 className="mb-[18px] text-[22px] font-semibold tracking-[-0.01em]">
          {isNew ? 'New metric' : 'Edit metric'}
        </h1>

        {isNew && showTemplates && (
          <TemplateGallery onPick={applyTemplate} onSkip={() => setShowTemplates(false)} />
        )}

        {/* Top row: Details on the left, Kind + its primary config on the right
            (roughly matched heights, full page width). */}
        <div className="grid grid-cols-1 gap-x-5 lg:grid-cols-2">
          <div>
            <SCard title="Details">
              <MField
                label="Display name"
                htmlFor="metric-display-name"
                required
                error={fieldErrors['metric-display-name']}
              >
                <TextInput id="metric-display-name" value={displayName} onChange={onDisplayNameChange} placeholder="Checkout conversion" aria-required />
              </MField>
              <MField
                label="Internal name"
                htmlFor={isNew ? 'metric-name' : undefined}
                required={isNew}
                hint={isNew ? 'Stable identifier used in queries.' : "Can't be changed after creation."}
                error={isNew ? fieldErrors['metric-name'] : undefined}
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
              <MField label="Unit" htmlFor="metric-unit" hint="Optional display unit (e.g. %, ms). With %, stored fractions render ×100 (0.08 → 8 %).">
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
              <MField label="Metric kind" stacked last>
                <RadioCards
                  groupLabel="Metric kind"
                  value={kind}
                  onChange={value => changeKind(value as MetricKind)}
                  options={KIND_OPTIONS}
                />
              </MField>
            </SCard>

            {/* Light, kind-specific config sits beside Details to balance the
                row; only the wide parts (SQL editor, fact operands) go full-width
                below. */}
            {kind === 'sql' && (
              <SCard title="Source" description="Where the query runs, and how often.">
                <MField
                  label="Data source"
                  htmlFor="metric-sql-data-source"
                  required
                  error={fieldErrors['metric-sql-data-source']}
                >
                  <Select id="metric-sql-data-source" value={dataSourceId} onChange={onDataSourceChange} options={dataSourceOptions} />
                </MField>
                <MField label="Collection interval" htmlFor="metric-sql-interval" required last>
                  <Select
                    id="metric-sql-interval"
                    value={interval}
                    onChange={value => setIntervalValue(value as MetricScanInterval)}
                    options={METRIC_SCAN_INTERVALS.map(i => ({ value: i, label: INTERVAL_LABEL[i] }))}
                  />
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
                    options={METRIC_SCAN_INTERVALS.map(i => ({ value: i, label: INTERVAL_LABEL[i] }))}
                  />
                </MField>
              </SCard>
            )}

            {kind === 'event_composition' && (
              <SCard title="Event composition" description="Combine existing event series.">
                <MField label="Composition" htmlFor="metric-composition" required>
                  <Select
                    id="metric-composition"
                    value={composition}
                    onChange={value => setComposition(value as MetricComposition)}
                    options={METRIC_COMPOSITIONS.map(c => ({ value: c, label: COMPOSITION_LABEL[c] }))}
                  />
                </MField>
                <MField
                  label={composition === 'ratio' ? 'Numerator event' : 'Event'}
                  htmlFor="metric-numerator"
                  required
                  last={composition === 'single'}
                  error={fieldErrors['metric-numerator']}
                >
                  <Select id="metric-numerator" value={numeratorEventId} onChange={onNumeratorEventChange} options={eventOptions} />
                </MField>
                {composition === 'ratio' && (
                  <MField
                    label="Denominator event"
                    htmlFor="metric-denominator"
                    required
                    last
                    hint="Required for a ratio metric."
                    error={fieldErrors['metric-denominator']}
                  >
                    <Select
                      id="metric-denominator"
                      value={denominatorEventId}
                      onChange={onDenominatorEventChange}
                      options={eventOptions}
                    />
                  </MField>
                )}
                {composition === 'per_distinct_user' && (
                  <MField
                    label="User ID column"
                    htmlFor="metric-user-id-column"
                    last
                    hint="Column counted for distinct users. Defaults to user_id."
                  >
                    <div className="max-w-[280px]">
                      <TextInput
                        id="metric-user-id-column"
                        value={userIdColumn}
                        onChange={setUserIdColumn}
                        mono
                        placeholder="user_id"
                      />
                    </div>
                  </MField>
                )}
              </SCard>
            )}
          </div>
        </div>

        {/* Only the wide parts go full-width; data source / interval live in the
            Source card beside Details above. */}
        {kind === 'sql' && (
          <SCard title="Query" description="A custom query returning one numeric value per bucket.">
            <MField
              label="Metric SQL"
              htmlFor="metric-sql-query"
              required
              stacked
              error={fieldErrors['metric-sql-query']}
            >
              <SqlEditor
                id="metric-sql-query"
                ariaLabel="Metric SQL"
                value={metricSql}
                onChange={onMetricSqlChange}
                placeholder="SELECT date_trunc('hour', created_at) AS bucket, count(*) AS value FROM events GROUP BY 1"
                dialect={selectedDataSource?.db_type}
                tables={sqlSchemaData?.tables}
                minHeight="220px"
              />
              <div className="mt-[10px] flex items-center gap-[10px]">
                <button
                  type="button"
                  onClick={onPreview}
                  disabled={!canPreview}
                  className="inline-flex h-8 items-center gap-[6px] rounded-[7px] border px-3 text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
                  style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
                >
                  {previewMut.isPending ? (
                    <Loader2 className="animate-spin" size={12} />
                  ) : (
                    <Play size={12} />
                  )}
                  {previewMut.isPending ? 'Running…' : 'Preview'}
                </button>
                <span className="text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
                  Dry-run against the data source over recent buckets; nothing is saved.
                </span>
              </div>
              {previewMut.isError && (
                <div className="mt-[10px]">
                  <ErrorState compact title="Preview failed" error={previewMut.error} />
                </div>
              )}
              {preview && <SqlPreviewPanel result={preview} color={color} />}
            </MField>
            <MField
              label="Time column"
              htmlFor="metric-sql-time"
              required
              hint="The bucket/time column returned by the query."
              error={fieldErrors['metric-sql-time']}
            >
              <div className="max-w-[280px]">
                <ColumnSuggestInput
                  id="metric-sql-time"
                  value={sqlTimeColumn}
                  onChange={onSqlTimeColumnChange}
                  suggestions={schemaColumns}
                  placeholder="bucket"
                />
              </div>
            </MField>
            <MField label="Value column" htmlFor="metric-sql-value" last hint="The projected measure column. Defaults to value.">
              <div className="max-w-[280px]">
                <ColumnSuggestInput
                  id="metric-sql-value"
                  value={sqlValueColumn}
                  onChange={onSqlValueColumnChange}
                  suggestions={schemaColumns}
                  placeholder="value"
                />
              </div>
            </MField>
          </SCard>
        )}

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
                slug={slug}
                idPrefix="metric-fact"
                operand={numeratorOp}
                onChange={setNumeratorOp}
                factTableOptions={factTableOptions}
                detail={numeratorDetail}
                loading={numeratorDetailLoading}
                detailError={numeratorDetailQuery.isError}
                errors={fieldErrors}
              />
            </SCard>
          ) : (
            <div className="grid grid-cols-1 gap-x-5 lg:grid-cols-2">
              <div>
                <SCard title="Numerator">
                  <FactOperandEditor
                    slug={slug}
                    idPrefix="metric-fact-num"
                    operand={numeratorOp}
                    onChange={setNumeratorOp}
                    factTableOptions={factTableOptions}
                    detail={numeratorDetail}
                    loading={numeratorDetailLoading}
                    detailError={numeratorDetailQuery.isError}
                    errors={fieldErrors}
                  />
                </SCard>
              </div>
              <div>
                <SCard title="Denominator" description="May reference a different fact table.">
                  <FactOperandEditor
                    slug={slug}
                    idPrefix="metric-fact-den"
                    operand={denominatorOp}
                    onChange={setDenominatorOp}
                    factTableOptions={factTableOptions}
                    detail={denominatorDetail}
                    loading={denominatorDetailLoading}
                    detailError={denominatorDetailQuery.isError}
                    errors={fieldErrors}
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
            last={kind === 'event_composition'}
          />
          {/* Breakdowns roll up warehouse columns; event-composition metrics have
              no data source, so hide these dimension inputs for that kind. */}
          {kind !== 'event_composition' && (
            <>
              <MField label="Breakdown columns" hint="Warehouse columns to roll up by. Tick the columns to break this metric down by.">
                <div className="max-w-[420px]">
                  <ColumnCheckboxPicker
                    id="metric-breakdowns"
                    aria-label="Breakdown columns"
                    columns={breakdownColumnChoices}
                    value={breakdownColumns}
                    onChange={setBreakdownColumns}
                    reserved={[appVersionColumn, platformColumn].filter(Boolean)}
                  />
                </div>
              </MField>
              <MField label="App version column" htmlFor="metric-app-version" hint="Optional column used for by-version series.">
                <div className="max-w-[280px]">
                  <ColumnSuggestInput
                    id="metric-app-version"
                    value={appVersionColumn}
                    onChange={setAppVersionColumn}
                    suggestions={schemaColumns}
                    placeholder="app_version"
                  />
                </div>
              </MField>
              <MField label="Platform column" htmlFor="metric-platform" last hint="Optional platform dimension column.">
                <div className="max-w-[280px]">
                  <ColumnSuggestInput
                    id="metric-platform"
                    value={platformColumn}
                    onChange={setPlatformColumn}
                    suggestions={schemaColumns}
                    placeholder="platform"
                  />
                </div>
              </MField>
            </>
          )}
        </SCard>

        {Object.keys(fieldErrors).length > 0 && (
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
              {Object.entries(fieldErrors).map(([key, error]) => (
                <li key={key}>{error}</li>
              ))}
            </ul>
          </div>
        )}

        {factDetailError && (
          <div className="mb-[18px]">
            <ErrorState
              compact
              title="Could not load fact table details"
              error={factDetailError}
            />
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
            disabled={saveMut.isPending || factDetailLoading || !!factDetailError}
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
      {kindDialog}
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
    queryKey: dataSourcesKey(),
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
