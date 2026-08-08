import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Play } from 'lucide-react'
import type { DataSource, EventType, IntervalCode } from '@/types'
import { useDataSourceSchema } from '@/hooks/useDataSourceSchema'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorState } from '@/components/error-state'
import { AppVersionFields } from './AppVersionFields'
import { CreateMissingFieldsButton } from './CreateMissingFieldsButton'
import { DistributionDriftPicker } from './DistributionDriftPicker'
import { EventGroupRulesEditor } from './EventGroupRulesEditor'
import { JsonValuePathsPicker } from './JsonValuePathsPicker'
import { MetricBreakdownPicker } from './MetricBreakdownPicker'
import { ScanCausalNote } from './ScanCausalNote'
import { ScanPreviewPanel } from './ScanPreviewPanel'
import { SqlEditor } from '@/components/sql-editor'
import { Field, SCard } from './scanLayout'
import type { ScanFormMode } from './scanMode'
import { CHUNK_LABELS, SELECT_CLASS, eligibleChunkIntervals } from './scanUtils'
import type { UseScanFormResult } from './useScanForm'

// The manual/"no schedule" option is gone: a schedule is only ever asked for in
// Catalog + monitoring, where leaving it empty is the defect this form exists to
// prevent. Catalog only does not render the field at all.
const INTERVAL_OPTIONS: { value: IntervalCode; label: string }[] = [
  { value: '15m', label: 'Every 15 min' },
  { value: '1h', label: 'Every hour' },
  { value: '6h', label: 'Every 6 hours' },
  { value: '1d', label: 'Every day' },
  { value: '1w', label: 'Every week' },
]

const MODE_OPTIONS: {
  value: ScanFormMode
  label: string
  description: string
}[] = [
  {
    value: 'monitoring',
    label: 'Catalog + monitoring',
    description:
      'Ingest events into your tracking plan and collect metrics, so anomalies and alerts can fire. Needs a time column and a schedule.',
  },
  {
    value: 'catalog',
    label: 'Catalog only',
    description: 'Discover events and fields. No metrics, no anomalies, no alerts.',
  },
]

const PREVIEW_GATE_TEXT =
  "Load preview first — tripl needs your query's columns to offer choices here."

interface SectionProps {
  form: UseScanFormResult
  slug: string
  branchId: string | null
  dataSources: DataSource[]
  eventTypes: EventType[]
  // Configuration tab locks the data source (a scan can't change source); the
  // create page lets the user pick one.
  sourceLocked: boolean
  // Configuration tab supplies a per-card Save footer; the create page omits it
  // and uses a single Create button at the bottom of the page instead.
  footerFor?: () => React.ReactNode
}

/**
 * An advanced section, collapsed until asked for.
 *
 * The header carries one line of "what this is for and what happens if you leave
 * it alone" — the form asks 22 questions and eight of them need knowledge of
 * tripl's detection internals that exists nowhere else in the product.
 *
 * `defaultOpen` is computed by each caller from the form state, so editing a
 * config that already uses a section opens it rather than hiding the user's own
 * settings behind a chevron.
 */
function CollapsibleSection({
  title,
  explanation,
  defaultOpen,
  footer,
  children,
}: {
  title: string
  explanation: string
  defaultOpen: boolean
  footer?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section
      className="mb-5 overflow-hidden rounded-xl border"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
        className="flex w-full items-start gap-3 px-[18px] py-4 text-left transition-colors hover:bg-[var(--surface-hover)]"
      >
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-sm font-semibold" style={{ color: 'var(--fg)' }}>
            {title}
          </h3>
          <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--fg-subtle)' }}>
            {explanation}
          </p>
        </div>
        <Chevron className="mt-0.5 size-4 shrink-0" style={{ color: 'var(--fg-subtle)' }} aria-hidden="true" />
      </button>
      {open && (
        <>
          <div className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            {children}
          </div>
          {footer && (
            <footer
              className="flex items-center gap-2.5 border-t px-[18px] py-3"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-sunken)' }}
            >
              {footer}
            </footer>
          )}
        </>
      )}
    </section>
  )
}

function PreviewGate() {
  return (
    <p className="text-xs" style={{ color: 'var(--fg-faint)' }}>
      {PREVIEW_GATE_TEXT}
    </p>
  )
}

/**
 * Everything a scan cannot be created without, always visible: what the scan
 * does, where it reads from, and — in Catalog + monitoring only — the two
 * columns that decide whether it is ever dispatched.
 */
export function ScanEssentialsSection({
  form,
  slug,
  branchId,
  dataSources,
  eventTypes,
  sourceLocked,
  footerFor,
}: SectionProps) {
  const {
    state, set, preview, dryRun, dryRunStale,
    setBaseQuery, setDataSourceId, setTimeColumn, setInterval,
    previewMut, dryRunMut, loadPreview, runDryRun,
  } = form
  const monitoring = state.mode === 'monitoring'
  const selectedSource = dataSources.find(ds => ds.id === state.dataSourceId)
  const sourceName = selectedSource?.name ?? ''
  const { data: schemaData } = useDataSourceSchema(state.dataSourceId || undefined)

  return (
    <SCard title="" footer={footerFor?.()}>
      <fieldset
        data-testid="scan-mode"
        className="border-b px-[18px] py-4"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <legend className="mb-2 text-[13px] font-medium" style={{ color: 'var(--fg)' }}>
          What this scan does
        </legend>
        <div className="flex flex-col gap-2">
          {MODE_OPTIONS.map(option => (
            <div
              key={option.value}
              className="flex items-start gap-2.5 rounded-lg border p-3"
              style={{
                borderColor: state.mode === option.value ? 'var(--accent)' : 'var(--border-subtle)',
              }}
            >
              <input
                type="radio"
                id={`scan-mode-${option.value}`}
                name="scan-mode"
                className="mt-0.5"
                value={option.value}
                checked={state.mode === option.value}
                aria-describedby={`scan-mode-${option.value}-description`}
                onChange={() => set('mode', option.value)}
              />
              <div className="min-w-0">
                <label
                  htmlFor={`scan-mode-${option.value}`}
                  className="block text-[13px] font-medium"
                  style={{ color: 'var(--fg)' }}
                >
                  {option.label}
                </label>
                <p
                  id={`scan-mode-${option.value}-description`}
                  className="mt-0.5 text-xs leading-snug"
                  style={{ color: 'var(--fg-subtle)' }}
                >
                  {option.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      {/* Next sibling of the mode radio: the consequence of the selection above,
          restated as the chain it feeds (tripl-3y7z.2). */}
      <div className="border-b px-[18px] pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
        <ScanCausalNote variant="form" mode={state.mode} />
      </div>

      <Field label="Name" id="scan-name">
        <Input
          id="scan-name"
          value={state.name}
          onChange={e => set('name', e.target.value)}
          placeholder="e.g. Main events scan"
        />
      </Field>
      <Field label="Data source" id="scan-data-source">
        {sourceLocked ? (
          <Input id="scan-data-source" value={sourceName} disabled className="max-w-[280px]" />
        ) : (
          <select
            id="scan-data-source"
            value={state.dataSourceId}
            onChange={e => setDataSourceId(e.target.value)}
            className={`${SELECT_CLASS} max-w-[280px]`}
          >
            <option value="">Select…</option>
            {dataSources.map(ds => (
              <option key={ds.id} value={ds.id}>{ds.name}</option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Base query" hint="Used as a subquery. tripl wraps it to scan windows.">
        <SqlEditor
          ariaLabel="SQL base query"
          value={state.baseQuery}
          onChange={setBaseQuery}
          placeholder="SELECT * FROM analytics.events"
          dialect={selectedSource?.db_type}
          tables={schemaData?.tables}
        />
      </Field>
      <Field
        label="Preview"
        hint="Shows what this scan would create, and the sample rows the column pickers use."
      >
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={loadPreview}
            disabled={previewMut.isPending || !state.dataSourceId || !state.baseQuery.trim()}
          >
            <Play className="size-3" />
            {previewMut.isPending ? 'Loading…' : preview ? 'Reload preview' : 'Load preview'}
          </Button>
          {previewMut.isError && <ErrorState compact title="Preview failed" error={previewMut.error} />}
        </div>
      </Field>
      {preview && (
        <div className="border-b px-[18px] py-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <ScanPreviewPanel
            preview={preview}
            dryRun={dryRun}
            dryRunStale={dryRunStale}
            dryRunPending={dryRunMut.isPending}
            dryRunError={dryRunMut.isError ? dryRunMut.error : null}
            onRecheck={runDryRun}
          />
        </div>
      )}

      <Field
        label="Event type"
        id="scan-event-type"
        hint="Leave on auto-detect to derive from the data."
        last={!monitoring}
      >
        <select
          id="scan-event-type"
          value={state.eventTypeId}
          onChange={e => set('eventTypeId', e.target.value)}
          className={`${SELECT_CLASS} max-w-[280px]`}
        >
          <option value="">Auto-detect</option>
          {eventTypes.map(et => <option key={et.id} value={et.id}>{et.display_name}</option>)}
        </select>
      </Field>
      {preview && state.eventTypeId && (
        <div className="border-b px-[18px] pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <CreateMissingFieldsButton
            slug={slug}
            eventType={eventTypes.find(et => et.id === state.eventTypeId)}
            preview={preview}
            eventTypeColumn={state.eventTypeColumn}
            timeColumn={state.timeColumn}
            branchId={branchId}
          />
        </div>
      )}

      {/* Catalog only shows neither field and no warning: empty is a deliberate
          answer there, and nagging about it would be the product second-guessing
          a choice the user just made. */}
      {monitoring && (
        <>
          <Field
            label="Time column"
            id="scan-time-column"
            hint="The timestamp tripl buckets metrics by. Required for monitoring."
          >
            <select
              id="scan-time-column"
              value={state.timeColumn}
              onChange={e => setTimeColumn(e.target.value)}
              className={`${SELECT_CLASS} max-w-[280px]`}
              disabled={!preview}
            >
              <option value="" disabled>{preview ? 'Choose a time column' : 'Load preview first'}</option>
              {preview?.columns.map(column => (
                <option key={column.name} value={column.name}>{column.name}</option>
              ))}
            </select>
            {!state.timeColumn && (
              <p role="alert" className="mt-1.5 text-xs" style={{ color: 'var(--warning)' }}>
                Pick a time column — monitoring needs one to build a time series.
              </p>
            )}
          </Field>
          <Field label="Schedule" id="scan-interval" hint="How often this scan runs." last>
            <select
              id="scan-interval"
              value={state.interval}
              onChange={e => setInterval(e.target.value)}
              className={`${SELECT_CLASS} max-w-[280px]`}
            >
              <option value="" disabled>Choose a schedule</option>
              {INTERVAL_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            {!state.interval && (
              <p role="alert" className="mt-1.5 text-xs" style={{ color: 'var(--warning)' }}>
                Pick a schedule — monitoring needs one to collect metrics.
              </p>
            )}
          </Field>
        </>
      )}
    </SCard>
  )
}

export function EventNamingSection({ form, footerFor }: SectionProps) {
  const {
    state, set, preview,
    setEventTypeColumn, toggleJsonValuePath, discoverJsonMut,
  } = form
  const defaultOpen = Boolean(
    state.eventTypeColumn
    || state.eventNameFormat
    || state.cardinalityThreshold !== 100
    || state.eventGroupRules.length
    || state.jsonValuePaths.length,
  )

  return (
    <CollapsibleSection
      title="Event names and grouping"
      explanation="How tripl turns warehouse rows into event names. Leave this alone and events are named from the column values already in your data."
      defaultOpen={defaultOpen}
      footer={footerFor?.()}
    >
      <Field label="Event type column" id="scan-event-type-column">
        <select
          id="scan-event-type-column"
          value={state.eventTypeColumn}
          onChange={e => setEventTypeColumn(e.target.value)}
          className={`${SELECT_CLASS} max-w-[280px]`}
          disabled={!preview}
        >
          <option value="">{preview ? 'No grouping' : 'Load preview first'}</option>
          {preview?.columns.map(column => (
            <option key={column.name} value={column.name}>{column.name}</option>
          ))}
        </select>
      </Field>
      <Field label="Event name format" id="scan-event-name-format" hint="Template, e.g. {action}:{category}.">
        <Input
          id="scan-event-name-format"
          value={state.eventNameFormat}
          onChange={e => set('eventNameFormat', e.target.value)}
          className="font-mono max-w-[280px]"
          placeholder="{action}"
        />
      </Field>
      <Field
        label="Cardinality threshold"
        id="cardinality-threshold"
        hint="Columns with more distinct values than this are collapsed into a template like {country} instead of one event per value."
        last
      >
        <Input
          id="cardinality-threshold"
          type="number"
          min={1}
          value={state.cardinalityThreshold}
          onChange={e => set('cardinalityThreshold', Number(e.target.value))}
          className="font-mono max-w-[280px]"
        />
      </Field>
      <div className="space-y-4 border-t px-[18px] py-4" style={{ borderColor: 'var(--border-subtle)' }}>
        <EventGroupRulesEditor
          rules={state.eventGroupRules}
          columns={preview?.columns}
          onChange={rules => set('eventGroupRules', rules)}
        />
        {preview ? (
          <JsonValuePathsPicker
            preview={preview}
            selectedJsonValuePaths={state.jsonValuePaths}
            onToggleJsonValuePath={toggleJsonValuePath}
            onDiscoverJsonPaths={() => discoverJsonMut.mutate()}
            isDiscoveringJsonPaths={discoverJsonMut.isPending}
            jsonPathsError={discoverJsonMut.error}
            jsonPathsDiscovered={discoverJsonMut.isSuccess}
          />
        ) : (
          <PreviewGate />
        )}
      </div>
    </CollapsibleSection>
  )
}

export function AppVersionSection({ form, footerFor }: SectionProps) {
  const { state, setAppVersionColumn, setPlatformColumn, set, preview } = form
  const defaultOpen = Boolean(
    state.appVersionColumn
    || state.platformColumn
    || state.appVersionPrereleasePattern
    || state.appVersionActiveShareMin,
  )

  return (
    <CollapsibleSection
      title="App version"
      explanation="Attach an app release and platform to every event. Leave this alone if you do not ship versioned apps."
      defaultOpen={defaultOpen}
      footer={footerFor?.()}
    >
      <div className="px-[18px] py-4">
        <AppVersionFields
          columns={preview?.columns ?? null}
          appVersionColumn={state.appVersionColumn}
          prereleasePattern={state.appVersionPrereleasePattern}
          activeShareMin={state.appVersionActiveShareMin}
          platformColumn={state.platformColumn}
          onAppVersionColumnChange={setAppVersionColumn}
          onPrereleasePatternChange={value => set('appVersionPrereleasePattern', value)}
          onActiveShareMinChange={value => set('appVersionActiveShareMin', value)}
          onPlatformColumnChange={setPlatformColumn}
        />
      </div>
    </CollapsibleSection>
  )
}

/** Rendered only in Catalog + monitoring — there are no metrics to break down otherwise. */
export function MetricsDriftSection({ form, footerFor }: SectionProps) {
  const {
    state, set, preview,
    toggleMetricBreakdownColumn, toggleDistributionDriftField,
  } = form
  if (state.mode !== 'monitoring') return null

  const defaultOpen = Boolean(
    state.metricBreakdownColumns.length
    || state.distributionDriftFields.length
    || state.metricBreakdownValuesLimit,
  )

  return (
    <CollapsibleSection
      title="Metric breakdowns and drift"
      explanation="Extra columns to split metrics by, and columns whose value mix you want watched for drift. Leave this alone to collect one series per event."
      defaultOpen={defaultOpen}
      footer={footerFor?.()}
    >
      <div className="space-y-4 px-[18px] py-4">
        {preview ? (
          <>
            <MetricBreakdownPicker
              columns={preview.columns}
              selectedColumns={state.metricBreakdownColumns}
              eventTypeColumn={state.eventTypeColumn}
              timeColumn={state.timeColumn}
              appVersionColumn={state.appVersionColumn}
              platformColumn={state.platformColumn}
              valuesLimit={state.metricBreakdownValuesLimit}
              onToggleColumn={toggleMetricBreakdownColumn}
              onValuesLimitChange={value => set('metricBreakdownValuesLimit', value)}
            />
            <DistributionDriftPicker
              columns={preview.columns}
              selectedFields={state.distributionDriftFields}
              eventTypeColumn={state.eventTypeColumn}
              timeColumn={state.timeColumn}
              appVersionColumn={state.appVersionColumn}
              platformColumn={state.platformColumn}
              onToggleField={toggleDistributionDriftField}
            />
          </>
        ) : (
          <PreviewGate />
        )}
      </div>
    </CollapsibleSection>
  )
}

export function LimitsSection({ form, footerFor }: SectionProps) {
  const { state, set } = form
  const monitoring = state.mode === 'monitoring'
  // A create-page lookback of "24" is this form's own default, not a user choice,
  // so it must not spring the section open on every edit of a fresh config.
  const lookbackIsCustom = state.scanLookbackHours !== '' && state.scanLookbackHours !== '24'
  const defaultOpen = Boolean(
    state.chunkInterval || lookbackIsCustom || state.scanRowLimit || state.metricsRowLimit,
  )

  return (
    <CollapsibleSection
      title="Limits"
      explanation="Caps on how much warehouse data each run reads. Leave these alone unless runs are slow or expensive."
      defaultOpen={defaultOpen}
      footer={footerFor?.()}
    >
      {monitoring && state.interval && (
        <Field
          label="Replay chunk size"
          id="scan-chunk-interval"
          hint="Splits long replays into smaller warehouse queries. Must be at least as long as the schedule."
        >
          <select
            id="scan-chunk-interval"
            value={state.chunkInterval}
            onChange={e => set('chunkInterval', e.target.value)}
            className={`${SELECT_CLASS} max-w-[280px]`}
          >
            <option value="">Whole window (no split)</option>
            {eligibleChunkIntervals(state.interval as IntervalCode).map(code => (
              <option key={code} value={code}>{CHUNK_LABELS[code]}</option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Lookback (hours)" id="scan-lookback-hours" hint="How far back each run reads. Default 24.">
        <Input
          id="scan-lookback-hours"
          type="number"
          min={1}
          value={state.scanLookbackHours}
          onChange={e => set('scanLookbackHours', e.target.value)}
          className="font-mono max-w-[280px]"
          placeholder="Default"
        />
      </Field>
      <Field label="Row cap per run" id="scan-row-limit">
        <Input
          id="scan-row-limit"
          type="number"
          min={1}
          value={state.scanRowLimit}
          onChange={e => set('scanRowLimit', e.target.value)}
          className="font-mono max-w-[280px]"
          placeholder="Default"
        />
      </Field>
      <Field label="Row cap per metrics run" id="scan-metrics-row-limit" last>
        <Input
          id="scan-metrics-row-limit"
          type="number"
          min={1}
          value={state.metricsRowLimit}
          onChange={e => set('metricsRowLimit', e.target.value)}
          className="font-mono max-w-[280px]"
          placeholder="Default"
        />
      </Field>
    </CollapsibleSection>
  )
}
