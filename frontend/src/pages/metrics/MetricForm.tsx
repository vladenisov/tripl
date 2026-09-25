import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, ChevronLeft, Loader2, Plus, Save } from 'lucide-react'
import { dataSourcesApi } from '@/api/dataSources'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { ErrorState } from '@/components/error-state'
import { ReadOnlyNotice } from '@/components/read-only-notice'
import {
  RadioCards,
  SCard,
  Select,
  TextArea,
  TextInput,
} from '@/components/settings/kit'
import { useConfirm } from '@/hooks/useConfirm'
import { useDataSourceSchema } from '@/hooks/useDataSourceSchema'
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { isIntervalFinerThan } from '@/lib/metricFormat'
import { getMetricMonitoringPath } from '@/lib/monitoring'
import { useCanWriteProject } from '@/lib/permissions'
import {
  dataSourcesKey,
  metricDefinitionKey,
  metricDrilldownKeys,
  metricGeneratedSqlKey,
  metricsCatalogKey,
} from '@/lib/queryKeys'
import {
  METRIC_STATUSES,
  METRIC_STATUS_LABEL,
  type DataSource,
  type MetricDefinitionDetailResponse,
  type MetricKind,
  type MetricScanInterval,
  type MetricStatus,
} from '@/types'
import { EventCompositionFields } from './EventCompositionFields'
import { FactDefinitionFields } from './FactDefinitionFields'
import { MetricField } from './MetricField'
import { MonitoringFields } from './MonitoringFields'
import { SqlDefinitionFields } from './SqlDefinitionFields'
import { TemplateGallery } from './TemplateGallery'
import { errorAria, focusField } from './fieldErrors'
import {
  columnsOfReferencedTables,
  draftFromMetric,
  savedDimensions,
  toIdentifier,
  validateDraft,
  type FactComposition,
  type MetricDraft,
} from './metricDraft'
import {
  buildCreatePayload,
  buildUpdatePayload,
  definitionSignature,
  type OperandColumns,
} from './metricPayload'
import {
  isPristineStarterSql,
  starterSql,
  type MetricTemplate,
  type SqlTemplateId,
} from './metricTemplates'
import { useFactTableDetails } from './useFactTableDetails'

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

/** What the history-loss confirm and the inline notice both say. */
const DEFINITION_CHANGE_MESSAGE =
  "This changes what the metric measures. Saving deletes its collected values, breakdowns and anomalies, and collection starts over from scratch."

/**
 * Shown on an edit once the definition differs from the saved one, so the
 * consequence is visible before Save rather than only in the confirm.
 */
function DefinitionChangeNotice() {
  return (
    <div
      role="status"
      className="mb-[18px] flex items-start gap-2 rounded-[10px] border px-4 py-3 text-[12.5px]"
      style={{
        background: 'var(--warning-soft, var(--bg-sunken))',
        borderColor: 'color-mix(in oklab, var(--warning, var(--border)) 40%, var(--border))',
        color: 'var(--fg)',
      }}
    >
      <AlertTriangle size={14} className="mt-px shrink-0" aria-hidden="true" style={{ color: 'var(--warning, var(--fg-muted))' }} />
      <span>{DEFINITION_CHANGE_MESSAGE}</span>
    </div>
  )
}

interface MetricFormProps {
  slug: string
  metric: MetricDefinitionDetailResponse | null
  dataSources: DataSource[]
  /** The data-source list failed; only a SQL metric needs it, so it is shown there. */
  dataSourcesError?: unknown
  onRetryDataSources?: () => void
  /** Cancel / back. */
  onClose: () => void
  /** After a successful save; defaults to {@link onClose}. */
  onSaved?: (metricId: string, created: boolean) => void
}

/**
 * Create / edit a catalog metric. The internal name remains immutable after
 * creation, while kind + collection config can be redefined through the
 * update `definition` block. Client-side validation mirrors the backend
 * discriminated-union rules; server 422s surface through {@link ErrorState}.
 *
 * All form state is one {@link MetricDraft}; the payload, validation and
 * change detection are pure functions of it (metricDraft.ts, metricPayload.ts),
 * and each kind renders its own section component.
 */
export function MetricForm({
  slug,
  metric,
  dataSources,
  dataSourcesError,
  onRetryDataSources,
  onClose,
  onSaved,
}: MetricFormProps) {
  const qc = useQueryClient()
  // Create, update and preview are all EditorUserDep (MET-6).
  const canWrite = useCanWriteProject()
  const isNew = !metric

  const [draft, setDraft] = useState<MetricDraft>(() => draftFromMetric(metric))
  const patch = (next: Partial<MetricDraft>) => setDraft(current => ({ ...current, ...next }))

  // Tracks whether the user has typed the internal name directly; once they
  // have, we stop auto-deriving it from the display name.
  const [nameEdited, setNameEdited] = useState(false)
  // Stands in for a display name with no Latin letters to derive from; minted
  // once so it does not churn while the user types.
  const [fallbackName] = useState(() => `metric_${Date.now().toString(36)}`)
  // Which starter scaffold seeded the SQL, if any. Non-null only while the SQL is
  // still template output; it is what lets a data-source switch re-render the
  // query for the newly-selected warehouse.
  const [sqlTemplateId, setSqlTemplateId] = useState<SqlTemplateId | null>(null)
  // Columns the last clean SQL preview returned — what the query projects.
  const [previewColumns, setPreviewColumns] = useState<string[] | null>(null)
  // The replay chunk the last interval change dropped, to say so beside it.
  const [clearedReplayChunk, setClearedReplayChunk] = useState<MetricScanInterval | null>(null)
  // Errors are shown only once a submit was attempted, then re-derived from the
  // draft on every render: fixing a field clears its message, and a field that
  // stops rendering takes its message with it (MET-18).
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const { confirm, dialog: confirmDialog } = useConfirm()

  // Create-only starter gallery: shown pristine above the form; picking a
  // template or "Start from scratch" dismisses it. Never shown when editing.
  const [showTemplates, setShowTemplates] = useState(isNew)

  const facts = useFactTableDetails(slug, draft, dataSources)
  const operandColumns: OperandColumns = {
    numerator: facts.numerator.detail.columns,
    denominator: facts.denominator.detail.columns,
  }

  const selectedDataSource = dataSources.find(ds => ds.id === draft.dataSourceId)
  // The schema route is editor-only, so a read-only visitor would get a 403
  // for autocomplete they cannot use: skip the request instead.
  const { data: sqlSchemaData } = useDataSourceSchema(
    canWrite && draft.kind === 'sql' ? draft.dataSourceId || undefined : undefined,
  )

  // Columns this metric's own source can offer to the breakdown picker and the
  // column inputs: the fact table's for a fact metric; for SQL, what the last
  // preview returned, else the columns of the tables the query names.
  const sqlColumns = useMemo(() => {
    if (previewColumns) return previewColumns
    return columnsOfReferencedTables(sqlSchemaData?.tables ?? [], draft.metricSql)
  }, [previewColumns, sqlSchemaData, draft.metricSql])
  const columnChoices =
    draft.kind === 'fact' ? facts.numerator.detail.columns.map(column => column.name) : sqlColumns

  const fieldErrors = useMemo(
    () => (submitAttempted ? validateDraft(draft, isNew) : {}),
    [submitAttempted, draft, isNew],
  )

  // The saved definition's fingerprint, taken once. A difference at submit
  // means the backend will delete the metric's history (MET-1).
  const [savedSignature] = useState(() => (metric ? definitionSignature(draft) : null))
  const definitionChanged = savedSignature !== null && definitionSignature(draft) !== savedSignature

  // Every input the author can change, as one comparable string; the first
  // render's value is the baseline (MET-5).
  const draftSnapshot = JSON.stringify(draft)
  const [initialSnapshot] = useState(draftSnapshot)
  // A viewer's form is disabled and so never dirty.
  const unsaved = useUnsavedChangesGuard(canWrite && draftSnapshot !== initialSnapshot)

  const saveMut = useMutation({
    // Rendered inline at the foot of the form ("Could not save …").
    meta: SILENT_ERROR_META,
    mutationFn: () =>
      metric
        ? metricsCatalogApi.update(slug, metric.id, buildUpdatePayload(draft, operandColumns))
        : metricsCatalogApi.create(slug, buildCreatePayload(draft, operandColumns)),
    onSuccess: saved => {
      unsaved.release()
      void qc.invalidateQueries({ queryKey: metricsCatalogKey(slug) })
      void qc.invalidateQueries({ queryKey: metricGeneratedSqlKey(slug) })
      if (metric) {
        void qc.invalidateQueries({ queryKey: metricDefinitionKey(slug) })
        // A redefinition deleted the series, breakdowns and anomalies server-
        // side; the drilldown must not keep painting the old ones (MET-27).
        for (const key of metricDrilldownKeys(slug, metric.id)) {
          void qc.invalidateQueries({ queryKey: key })
        }
        void qc.invalidateQueries({ queryKey: ['activeSignals', slug] })
      }
      toast.success(isNew ? 'Metric created.' : 'Metric saved.')
      if (onSaved) onSaved(saved.id, isNew)
      else onClose()
    },
  })

  /**
   * Selecting a warehouse re-renders starter SQL for it.
   *
   * The starter query is dialect-specific — `toStartOfInterval` on ClickHouse,
   * `date_bin` on PostgreSQL, `TIMESTAMP_TRUNC` on BigQuery — so SQL seeded before a
   * source was picked (or picked for a *different* source) simply cannot run on this
   * one. It regenerates ONLY while the SQL is still pristine template output, so a
   * hand-written query is NEVER silently clobbered.
   */
  const onDataSourceChange = (value: string) => {
    const nextDbType = dataSources.find(ds => ds.id === value)?.db_type
    setPreviewColumns(null)
    setDraft(current => ({
      ...current,
      dataSourceId: value,
      metricSql:
        sqlTemplateId !== null && isPristineStarterSql(sqlTemplateId, current.metricSql)
          ? starterSql(sqlTemplateId, nextDbType)
          : current.metricSql,
    }))
  }

  // A stored replay chunk finer than the new interval would 422 on save, on a
  // field this form does not show: drop it, and say so (MET-10).
  const onIntervalChange = (next: MetricScanInterval) => {
    const chunk = draft.replayChunkInterval
    if (chunk && isIntervalFinerThan(chunk, next)) {
      setClearedReplayChunk(chunk)
      patch({ interval: next, replayChunkInterval: null })
      return
    }
    patch({ interval: next })
  }

  // The stored replay chunk belongs to the saved kind's collection; another
  // kind starts without one, and a chunk finer than the interval never returns.
  const savedReplayChunk = (kind: MetricKind, interval: MetricScanInterval) => {
    const chunk = metric?.kind === kind ? metric.replay_chunk_interval ?? null : null
    return chunk && isIntervalFinerThan(chunk, interval) ? null : chunk
  }

  // Switching kind swaps which config fields render. Dimension columns belong
  // to one kind's source (a data-source schema, or a fact table), so they are
  // reset to what was saved for the new kind rather than carried across (MET-19).
  const applyKind = (next: MetricKind) => {
    setSubmitAttempted(false)
    setDraft(current => ({
      ...current,
      kind: next,
      ...savedDimensions(metric, next),
      replayChunkInterval: savedReplayChunk(next, current.interval),
    }))
  }
  // The history-loss confirm moved to submit, where it covers every change of
  // meaning, not only this one (MET-1).
  const changeKind = (next: MetricKind) => {
    if (next !== draft.kind) applyKind(next)
  }

  const onFactCompositionChange = (next: FactComposition) => {
    setSubmitAttempted(false)
    patch({ factComposition: next })
  }
  const onEventCompositionPatch = (next: Partial<MetricDraft>) => {
    if (next.composition !== undefined && next.composition !== draft.composition) {
      setSubmitAttempted(false)
    }
    patch(next)
  }

  const onDisplayNameChange = (value: string) => {
    // Pre-fill the internal name from the display name until the user edits it
    // directly (creation only — the internal name is immutable afterwards).
    patch(
      isNew && !nameEdited
        ? { displayName: value, name: toIdentifier(value, fallbackName) }
        : { displayName: value },
    )
  }

  const onSubmit = async () => {
    if (facts.loading || facts.error) return
    setSubmitAttempted(true)
    const errs = validateDraft(draft, isNew)
    const firstKey = Object.keys(errs)[0]
    if (firstKey) {
      focusField(firstKey)
      return
    }
    if (definitionChanged) {
      const ok = await confirm({
        title: 'Delete this metric’s history?',
        message: DEFINITION_CHANGE_MESSAGE,
        variant: 'danger',
        confirmLabel: 'Save and delete history',
      })
      if (!ok) return
    }
    saveMut.mutate()
  }

  // Seed the create form from a starter template, then reveal the (now
  // prefilled) form. Only editable presentation + kind-shape fields are set;
  // project-specific refs (data source, fact table, events, columns) stay empty
  // so the user still points the metric at their own data.
  const applyTemplate = (template: MetricTemplate) => {
    const { seed } = template
    applyKind(seed.kind)
    onDisplayNameChange(seed.displayName)
    setDraft(current => ({
      ...current,
      unit: seed.unit,
      anomalyDetection: seed.anomalyDetection,
      interval: seed.interval ?? current.interval,
      composition: seed.composition ?? current.composition,
      factComposition: seed.factComposition ?? current.factComposition,
      numeratorOp: seed.aggregation
        ? { ...current.numeratorOp, aggregation: seed.aggregation }
        : current.numeratorOp,
      // Render for whatever source is selected right now (usually none, on the
      // create screen); a data-source pick re-renders it.
      metricSql:
        seed.sqlTemplate !== undefined
          ? starterSql(seed.sqlTemplate, selectedDataSource?.db_type)
          : current.metricSql,
      sqlTimeColumn: seed.sqlTimeColumn ?? current.sqlTimeColumn,
    }))
    if (seed.sqlTemplate !== undefined) setSqlTemplateId(seed.sqlTemplate)
    setShowTemplates(false)
  }

  const errorEntries = Object.entries(fieldErrors)

  return (
    <div className="h-full overflow-y-auto">
      <form
        onSubmit={e => {
          e.preventDefault()
          void onSubmit()
        }}
        className="mx-auto max-w-[1100px] px-4 pb-12 pt-4 sm:px-6"
      >
        <button
          type="button"
          onClick={onClose}
          className="mb-[14px] inline-flex items-center gap-1 text-[11.5px] transition-colors hover:text-[var(--fg)]"
          style={{ color: 'var(--fg-muted)' }}
        >
          <ChevronLeft size={13} /> Back
        </button>
        <h1 className="mb-[18px] text-[22px] font-semibold tracking-[-0.01em]">
          {isNew ? 'New metric' : canWrite ? 'Edit metric' : 'Metric'}
        </h1>
        {!canWrite && <ReadOnlyNotice className="mb-[18px]" />}

        {/* A viewer gets the definition read-only: `disabled` on a fieldset
            reaches every native control inside it. `contents` keeps it out of
            the layout. */}
        <fieldset disabled={!canWrite} className="contents">
          {isNew && showTemplates && (
            <TemplateGallery onPick={applyTemplate} onSkip={() => setShowTemplates(false)} />
          )}

          {/* One column, full width — the same shape as the sibling event and
              fact-table forms: kit Field spends a fixed 232px on its label
              gutter from `sm` up, so nothing narrower than the page leaves a
              usable control (tripl-vv2f). */}
          <SCard title="Details">
            <MetricField
              label="Display name"
              htmlFor="metric-display-name"
              required
              error={fieldErrors['metric-display-name']}
            >
              <TextInput
                id="metric-display-name"
                value={draft.displayName}
                onChange={onDisplayNameChange}
                placeholder="Checkout conversion"
                aria-required
                {...errorAria(fieldErrors, 'metric-display-name')}
              />
            </MetricField>
            <MetricField
              label="Internal name"
              // After creation this row holds the name as text, not a control:
              // `false` names it as a group.
              htmlFor={isNew ? 'metric-name' : false}
              required={isNew}
              hint={isNew ? 'Stable identifier used in queries.' : "Can't be changed after creation."}
              error={isNew ? fieldErrors['metric-name'] : undefined}
            >
              {isNew ? (
                <TextInput
                  id="metric-name"
                  value={draft.name}
                  onChange={value => {
                    setNameEdited(true)
                    patch({ name: value })
                  }}
                  mono
                  placeholder="checkout_conversion"
                  aria-required
                  {...errorAria(fieldErrors, 'metric-name')}
                />
              ) : (
                <div className="mono text-[13px]" style={{ color: 'var(--fg)' }}>
                  {draft.name}
                </div>
              )}
            </MetricField>
            <MetricField label="Description" htmlFor="metric-description">
              <TextArea
                id="metric-description"
                value={draft.description}
                onChange={value => patch({ description: value })}
                rows={2}
                placeholder="What does this metric measure?"
              />
            </MetricField>
            <MetricField label="Unit" htmlFor="metric-unit" hint="Optional display unit (e.g. %, ms). With %, stored fractions render ×100 (0.08 → 8 %).">
              <TextInput id="metric-unit" value={draft.unit} onChange={value => patch({ unit: value })} placeholder="%" />
            </MetricField>
            <MetricField label="Color" htmlFor="metric-color">
              <input
                id="metric-color"
                type="color"
                value={draft.color}
                onChange={e => patch({ color: e.target.value })}
                className="h-8 w-12 cursor-pointer rounded border bg-transparent"
                style={{ borderColor: 'var(--border)' }}
              />
            </MetricField>
            <MetricField label="Status" htmlFor="metric-status" last>
              <Select
                id="metric-status"
                value={draft.status}
                onChange={value => patch({ status: value as MetricStatus })}
                options={METRIC_STATUSES.map(s => ({ value: s, label: METRIC_STATUS_LABEL[s] }))}
              />
            </MetricField>
          </SCard>

          <SCard title="Kind" description="How this metric produces its per-bucket value.">
            <MetricField label="Metric kind" stacked last>
              <RadioCards
                groupLabel="Metric kind"
                value={draft.kind}
                onChange={value => changeKind(value as MetricKind)}
                options={KIND_OPTIONS}
              />
            </MetricField>
          </SCard>

          {definitionChanged && <DefinitionChangeNotice />}

          {draft.kind === 'sql' && (
            <SqlDefinitionFields
              slug={slug}
              draft={draft}
              patch={patch}
              errors={fieldErrors}
              canWrite={canWrite}
              dataSources={dataSources}
              dataSourcesError={dataSourcesError}
              onRetryDataSources={onRetryDataSources}
              onDataSourceChange={onDataSourceChange}
              onIntervalChange={onIntervalChange}
              clearedReplayChunk={clearedReplayChunk}
              schemaTables={sqlSchemaData?.tables}
              columnSuggestions={sqlColumns}
              onPreviewColumns={setPreviewColumns}
            />
          )}
          {draft.kind === 'fact' && (
            <FactDefinitionFields
              slug={slug}
              draft={draft}
              patch={patch}
              errors={fieldErrors}
              facts={facts}
              onIntervalChange={onIntervalChange}
              onFactCompositionChange={onFactCompositionChange}
              clearedReplayChunk={clearedReplayChunk}
            />
          )}
          {draft.kind === 'event_composition' && (
            <EventCompositionFields
              slug={slug}
              draft={draft}
              patch={onEventCompositionPatch}
              errors={fieldErrors}
              disabled={!canWrite}
            />
          )}

          <MonitoringFields
            draft={draft}
            patch={patch}
            columnChoices={columnChoices}
            columnSource={draft.kind === 'fact' ? 'fact' : previewColumns ? 'preview' : 'schema'}
          />
        </fieldset>

        {errorEntries.length > 0 && (
          <div
            role="alert"
            className="mb-[18px] rounded-[10px] border px-4 py-3 text-[12.5px]"
            style={{
              background: 'var(--danger-soft)',
              borderColor: 'color-mix(in oklab, var(--danger) 35%, var(--border))',
              color: 'var(--danger)',
            }}
          >
            {/* Each message is a link to its field: a keyboard or screen-reader
                user lands on the control instead of hunting for it (MET-15). */}
            <ul className="list-disc space-y-1 pl-4">
              {errorEntries.map(([key, error]) => (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => focusField(key)}
                    className="text-left underline decoration-transparent underline-offset-2 hover:decoration-current focus-visible:decoration-current"
                  >
                    {error}
                  </button>
                </li>
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
            {canWrite ? 'Cancel' : 'Close'}
          </button>
          {canWrite && (
            <button
              type="submit"
              disabled={saveMut.isPending || facts.loading || facts.error != null}
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
          )}
        </div>
      </form>
      {confirmDialog}
      {unsaved.dialog}
    </div>
  )
}

const EMPTY_DATA_SOURCES: DataSource[] = []

/**
 * Route wrapper: loads what MetricForm needs (data sources, and — when editing
 * — the metric itself) and renders the form full-page. Reached via
 * `/p/:slug/metrics/new` and `/p/:slug/metrics/:metricId/edit`.
 *
 * Only the metric itself blocks the editor. Events are searched by the picker
 * that needs them, and a failed data-source list is shown in the SQL Source
 * card: a fact or event metric does not need it, so it must not lock the whole
 * editor out (MET-28).
 */
export default function MetricEditPage() {
  const { slug, metricId } = useParams<{ slug: string; metricId?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const isNew = !metricId

  // Back to wherever the editor was opened from — the catalog, or the metric's
  // own drilldown — and to the catalog when it was opened directly (MET-29).
  const goBack = () => {
    if (location.key !== 'default') navigate(-1)
    else navigate(`/p/${slug}/metrics`)
  }
  const onSaved = (savedId: string, created: boolean) => {
    if (created) navigate(getMetricMonitoringPath(slug!, savedId))
    else goBack()
  }

  const dataSourcesQuery = useQuery({
    queryKey: dataSourcesKey(),
    queryFn: () => dataSourcesApi.list(),
    // Rendered inline in the SQL Source card.
    meta: SILENT_ERROR_META,
  })
  const metricQuery = useQuery({
    queryKey: metricDefinitionKey(slug, metricId ?? 'new'),
    queryFn: () => metricsCatalogApi.get(slug!, metricId!),
    enabled: !!slug && !!metricId,
  })

  if (metricQuery.error) {
    return (
      <div className="mx-auto max-w-[880px] p-6">
        <ErrorState
          title="Failed to load metric editor"
          error={metricQuery.error}
          onRetry={() => void metricQuery.refetch()}
        />
      </div>
    )
  }

  // Data sources still block while LOADING: a SQL metric opened before its
  // source's option exists would paint the select blank.
  const isLoading = dataSourcesQuery.isLoading || (!isNew && metricQuery.isLoading)
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
      dataSourcesError={dataSourcesQuery.error ?? undefined}
      onRetryDataSources={() => void dataSourcesQuery.refetch()}
      onClose={goBack}
      onSaved={onSaved}
    />
  )
}

