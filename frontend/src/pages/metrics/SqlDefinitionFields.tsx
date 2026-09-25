import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Loader2, Play } from 'lucide-react'
import { metricsCatalogApi } from '@/api/metricsCatalog'
import { ColumnSuggestInput } from '@/components/column-suggest'
import { ErrorState } from '@/components/error-state'
import { Sparkline } from '@/components/primitives/sparkline'
import { SqlEditor } from '@/components/sql-editor'
import { SCard, Select, type SelectOption } from '@/components/settings/kit'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { formatMetricValue } from '@/lib/metricFormat'
import type {
  DataSource,
  MetricPreviewRequest,
  MetricPreviewResponse,
  MetricScanInterval,
} from '@/types'
import type { TableSchema } from '@/types/dataSourceSchema'
import { IntervalField } from './IntervalField'
import { FormField } from '@/components/settings/form-field'
import { errorAria, fieldErrorId, type FieldErrors } from '@/lib/fieldErrors'
import type { MetricDraft } from './metricDraft'

interface SqlPreviewPanelProps {
  result: MetricPreviewResponse
  color: string
  unit: string
}

/**
 * Compact result panel for the SQL dry-run. Expected user mistakes (bad SQL,
 * missing columns, warehouse errors) arrive as a 200 with `error` set and
 * render in the standard danger style; a successful run renders a chart that
 * follows the panel's width, the value range, and a mono summary line — or
 * says what an empty or one-point result most likely means (MET-44).
 */
function SqlPreviewPanel({ result, color, unit }: SqlPreviewPanelProps) {
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
  const values = points.map(p => p.value)
  const lastValue = values[values.length - 1]
  const summary = `${result.point_count} buckets · columns: ${columns.join(', ')}${
    result.truncated ? ' · truncated' : ''
  }`
  const guidance =
    points.length === 0
      ? 'The query ran but returned no rows in the preview window. Check its WHERE clause and time range, and that the time column holds recent timestamps.'
      : points.length === 1
        ? 'Only one bucket came back, so there is no trend to draw. Make sure the query groups by the time column.'
        : null
  const format = (value: number) => formatMetricValue(value, unit.trim() || null)
  return (
    <div
      role="status"
      className="mt-[10px] rounded-[10px] border px-4 py-3"
      style={{ borderColor: 'var(--border)' }}
    >
      {points.length > 1 && (
        <div className="mb-[8px]">
          <Sparkline data={values} color={color} width={560} height={64} responsive />
        </div>
      )}
      {lastValue !== undefined && (
        <p className="mono mb-[4px] text-[12px]" style={{ color: 'var(--fg)' }}>
          min {format(Math.min(...values))} · max {format(Math.max(...values))} · last{' '}
          {format(lastValue)}
        </p>
      )}
      {guidance && (
        <p className="mb-[4px] text-[12px]" style={{ color: 'var(--fg-muted)' }}>
          {guidance}
        </p>
      )}
      <p className="mono text-[12px]" style={{ color: 'var(--fg-muted)' }}>
        {summary}
      </p>
    </div>
  )
}

interface SqlDefinitionFieldsProps {
  slug: string
  draft: MetricDraft
  patch: (next: Partial<MetricDraft>) => void
  errors: FieldErrors
  canWrite: boolean
  dataSources: readonly DataSource[]
  /** The data-source list failed: shown here, the only card that needs it. */
  dataSourcesError?: unknown
  onRetryDataSources?: () => void
  onDataSourceChange: (id: string) => void
  onIntervalChange: (next: MetricScanInterval) => void
  clearedReplayChunk: MetricScanInterval | null
  schemaTables?: TableSchema[]
  /** Column names offered by the time/value inputs. */
  columnSuggestions: string[]
  /**
   * Columns the last clean preview returned, for the breakdown picker; `null`
   * once an edit invalidates that preview.
   */
  onPreviewColumns: (columns: string[] | null) => void
}

/**
 * The SQL metric's Source card (data source + interval) and Query card (SQL,
 * dry-run preview, time/value columns). The preview lives here because every
 * input it depends on does: editing any of them clears it.
 */
export function SqlDefinitionFields({
  slug,
  draft,
  patch,
  errors,
  canWrite,
  dataSources,
  dataSourcesError,
  onRetryDataSources,
  onDataSourceChange,
  onIntervalChange,
  clearedReplayChunk,
  schemaTables,
  columnSuggestions,
  onPreviewColumns,
}: SqlDefinitionFieldsProps) {
  // Last dry-run result, for the inputs it ran against.
  const [preview, setPreview] = useState<MetricPreviewResponse | null>(null)

  // Stateless dry-run of the current SQL config against the warehouse. User
  // mistakes come back as 200 with `error` set and render inside the result
  // panel; transport failures land in `previewMut.error` and render inline.
  const previewMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (payload: MetricPreviewRequest) => metricsCatalogApi.preview(slug, payload),
  })

  const canPreview =
    !!draft.dataSourceId
    && !!draft.metricSql.trim()
    && !!draft.sqlTimeColumn.trim()
    && !previewMut.isPending

  const onPreview = () => {
    setPreview(null)
    // The result is taken through the PER-CALL callback, not the options-level
    // one: TanStack drops per-call callbacks for a mutation `reset()` detached,
    // so a run still in flight when the SQL is edited can no longer paint its
    // result beside the edited query (MET-4).
    previewMut.mutate(
      {
        data_source_id: draft.dataSourceId,
        sql: draft.metricSql,
        time_column: draft.sqlTimeColumn.trim(),
        value_column: draft.sqlValueColumn.trim() || null,
        interval: draft.interval,
      },
      {
        onSuccess: result => {
          setPreview(result)
          if (!result.error && result.columns?.length) onPreviewColumns(result.columns)
        },
      },
    )
  }

  // The preview only describes the inputs it ran against; editing any of them
  // — the interval included, which the request carries — invalidates it.
  // The columns it returned go with it: the breakdown picker must not keep
  // offering what an edited query no longer projects.
  const resetPreview = () => {
    setPreview(null)
    previewMut.reset()
    onPreviewColumns(null)
  }

  const dataSourceOptions: SelectOption[] = [
    { value: '', label: 'Select data source…' },
    ...dataSources.map(ds => ({ value: ds.id, label: ds.name })),
  ]

  return (
    <>
      <SCard title="Source" description="Where the query runs, and how often.">
        <FormField
          label="Data source"
          htmlFor="metric-sql-data-source"
          required
          error={errors['metric-sql-data-source']}
        >
          <Select
            id="metric-sql-data-source"
            value={draft.dataSourceId}
            onChange={value => {
              resetPreview()
              onDataSourceChange(value)
            }}
            options={dataSourceOptions}
            aria-required
            {...errorAria(errors, 'metric-sql-data-source')}
          />
          {dataSourcesError != null && (
            <div className="mt-[8px]">
              <ErrorState
                compact
                title="Could not load data sources"
                error={dataSourcesError}
                onRetry={onRetryDataSources}
              />
            </div>
          )}
        </FormField>
        <IntervalField
          id="metric-sql-interval"
          value={draft.interval}
          onChange={next => {
            resetPreview()
            onIntervalChange(next)
          }}
          replayChunkInterval={draft.replayChunkInterval}
          clearedReplayChunk={clearedReplayChunk}
        />
      </SCard>

      {/* The query itself, below the Source card that says where it runs. */}
      <SCard title="Query" description="A custom query returning one numeric value per bucket.">
        <FormField
          label="Metric SQL"
          htmlFor="metric-sql-query"
          required
          stacked
          error={errors['metric-sql-query']}
        >
          <SqlEditor
            id="metric-sql-query"
            ariaLabel="Metric SQL"
            value={draft.metricSql}
            onChange={value => {
              resetPreview()
              patch({ metricSql: value })
            }}
            placeholder="SELECT date_trunc('hour', created_at) AS bucket, count(*) AS value FROM events GROUP BY 1"
            dialect={dataSources.find(ds => ds.id === draft.dataSourceId)?.db_type}
            tables={schemaTables}
            minHeight="220px"
            readOnly={!canWrite}
            ariaRequired
            ariaInvalid={!!errors['metric-sql-query']}
            ariaDescribedBy={errors['metric-sql-query'] ? fieldErrorId('metric-sql-query') : undefined}
          />
          <div className="mt-[10px] flex flex-wrap items-center gap-[10px]">
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
          {preview && <SqlPreviewPanel result={preview} color={draft.color} unit={draft.unit} />}
        </FormField>
        <FormField
          label="Time column"
          htmlFor="metric-sql-time"
          required
          hint="The bucket/time column returned by the query."
          error={errors['metric-sql-time']}
        >
          <div className="max-w-[280px]">
            <ColumnSuggestInput
              id="metric-sql-time"
              value={draft.sqlTimeColumn}
              onChange={value => {
                resetPreview()
                patch({ sqlTimeColumn: value })
              }}
              suggestions={columnSuggestions}
              placeholder="bucket"
              aria-required
              {...errorAria(errors, 'metric-sql-time')}
            />
          </div>
        </FormField>
        <FormField
          label="Value column"
          htmlFor="metric-sql-value"
          last
          hint="The projected measure column. Defaults to value."
        >
          <div className="max-w-[280px]">
            <ColumnSuggestInput
              id="metric-sql-value"
              value={draft.sqlValueColumn}
              onChange={value => {
                resetPreview()
                patch({ sqlValueColumn: value })
              }}
              suggestions={columnSuggestions}
              placeholder="value"
            />
          </div>
        </FormField>
      </SCard>
    </>
  )
}
