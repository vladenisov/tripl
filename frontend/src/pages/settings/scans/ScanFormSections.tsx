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
import {
  MONITORING_INCOMPLETE_TITLE,
  type UseScanFormResult,
  hasEventTarget,
  scanFormBlocker,
} from './useScanForm'

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
      'Adds events and fields to your tracking plan and records metric points, so anomalies and alerts can fire. Needs a time column and a schedule.',
  },
  {
    value: 'catalog',
    label: 'Catalog only',
    description:
      'Adds events and fields to your tracking plan when you run it. No schedule, so no metric points, no anomalies and no alerts.',
  },
]

const PREVIEW_GATE_TEXT =
  "Load preview first — tripl needs your query's columns to offer choices here."

// Module-private on purpose: the tests assert the rendered sentence, which is the
// only place it matters.
const NO_LOOKBACK_WITHOUT_TIME_COLUMN =
  'Each run reads everything the base query returns. Pick a Time column to bound runs to a window.'

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
 * does, where it reads from, the time column that bounds every run, and — in
 * Catalog + monitoring only — the schedule that, together with that column,
 * decides whether the dispatcher ever picks the config up.
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
    setBaseQuery, setDataSourceId, setEventTypeColumn, setTimeColumn, setInterval,
    previewMut, dryRunMut, loadPreview, runDryRun,
  } = form
  const monitoring = state.mode === 'monitoring'
  /**
   * Whether the monitoring pair is the FIRST thing standing between this draft
   * and a saved scan — the gate on both warnings below.
   *
   * A new scan opens on Catalog + monitoring with neither field set, so both
   * used to render on first paint: two red blocks on a form nobody had typed
   * into yet, the first of them pointing at a select the form had not enabled
   * (its options are the preview's columns). People stop reading a warning that
   * fires on the ordinary path, and these are the two that later mean "this scan
   * will never collect anything".
   *
   * `scanFormBlocker` already orders the requirements the way the form asks for
   * them, so reusing it costs nothing and cannot drift from the disabled Create
   * button's own reason. It also keeps the case that matters loud: a saved
   * never-dispatched config has its name, source, query and naming answered
   * already, so its edit form flags the missing time column immediately.
   */
  const monitoringPairIsNext = scanFormBlocker(state) === MONITORING_INCOMPLETE_TITLE
  // Kept on screen when it already holds a value even under an explicit event
  // type, so a saved config's column is never both invisible and unremovable.
  const namesEventsFromColumn = !state.eventTypeId || Boolean(state.eventTypeColumn)
  const selectedSource = dataSources.find(ds => ds.id === state.dataSourceId)
  const sourceName = selectedSource?.name ?? ''
  const { data: schemaData } = useDataSourceSchema(state.dataSourceId || undefined)

  // A saved config opens its edit form before any preview has been loaded, so
  // the column list is empty and a <select> whose value matches no option shows
  // its placeholder instead. That made an existing time column read as "not
  // set" on the one screen a user checks — so the saved value is always among
  // the choices, whether or not a preview has named it.
  const previewColumns = preview?.columns.map(column => column.name) ?? []
  const withSaved = (saved: string) =>
    saved && !previewColumns.includes(saved) ? [saved, ...previewColumns] : previewColumns
  const timeColumnChoices = withSaved(state.timeColumn)
  const eventTypeColumnChoices = withSaved(state.eventTypeColumn)

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
      {/* The button loads the sample rows; the ANSWER it also computes is
          rendered at the foot of this card, after the fields that feed it. */}
      <Field
        label="Preview"
        hint="Loads sample rows so the pickers below can offer real columns. What this scan would create is answered underneath them."
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

      {/* "Where does the event name come from?" is ONE question, so it is asked
          in one place. It used to be split: an "Auto-detect" default here, and
          the column auto-detect actually reads hidden in a collapsed section
          whose header said to leave it alone. Nothing detected anything — with
          neither set, `run_scan` and the dry-run planner both abort, so every
          scan created on the defaults failed its first run. "Auto-detect" is
          gone with it; the empty option now names the answer it stands for. */}
      <Field
        label="Event type"
        id="scan-event-type"
        hint="Give every row the same event type, or read each event's name from a column."
      >
        <select
          id="scan-event-type"
          value={state.eventTypeId}
          onChange={e => set('eventTypeId', e.target.value)}
          className={`${SELECT_CLASS} max-w-[280px]`}
        >
          <option value="">Name events from a column</option>
          {eventTypes.map(et => <option key={et.id} value={et.id}>{et.display_name}</option>)}
        </select>
      </Field>
      {namesEventsFromColumn && (
        <Field
          label="Event type column"
          id="scan-event-type-column"
          hint={
            state.eventTypeId
              ? 'The Event type above names these events, so this column names nothing — and it never becomes an event field either. Clear it if you did not mean to set it.'
              : "The column each row's event name is in. Every distinct value becomes its own event type."
          }
        >
          <select
            id="scan-event-type-column"
            value={state.eventTypeColumn}
            onChange={e => setEventTypeColumn(e.target.value)}
            className={`${SELECT_CLASS} max-w-[280px]`}
            disabled={!preview}
          >
            {/* Selectable only when an Event type carries the naming instead —
                otherwise clearing it would leave the scan unable to name a
                thing, which is the state this field exists to prevent. */}
            <option value="" disabled={!state.eventTypeId}>
              {preview
                ? state.eventTypeId
                  ? 'None'
                  : 'Choose a column'
                : 'Load preview first'}
            </option>
            {eventTypeColumnChoices.map(name => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          {/* Only once the column list exists: before that the select is
              disabled and the user is being flagged for not doing something the
              form has not let them do yet. The disabled Create button carries
              the gate in the meantime. */}
          {preview && !state.eventTypeColumn && !state.eventTypeId && (
            <p role="alert" className="mt-1.5 text-xs" style={{ color: 'var(--warning)' }}>
              Pick the column your event names are in — without it this scan cannot name a single
              event, and every run fails.
            </p>
          )}
        </Field>
      )}
      {/* The time column is asked for in BOTH modes, because it does two jobs and
          only one of them is monitoring: it buckets metric points, and it bounds
          every run to Limits → Lookback (hours). Catalog only drops the SCHEDULE
          — that alone is what makes a config catalog-only, since the dispatcher
          selects on `time_column IS NOT NULL AND interval IS NOT NULL`. Hiding
          this field in Catalog only is what let an unrelated edit null a saved
          column and hand the next run an unbounded full-table read. In Catalog
          only it is optional and says what leaving it empty costs; there is no
          warning, because empty is a legitimate answer there. */}
      <Field
        label="Time column"
        id="scan-time-column"
        hint={
          monitoring
            ? 'The timestamp tripl buckets metric points by. Required for monitoring.'
            : 'Optional. Bounds each run to the lookback window under Limits — without one, every run reads everything the base query returns.'
        }
        last={!monitoring && !preview}
      >
        <select
          id="scan-time-column"
          value={state.timeColumn}
          onChange={e => setTimeColumn(e.target.value)}
          className={`${SELECT_CLASS} max-w-[280px]`}
          disabled={!preview}
        >
          {/* Monitoring cannot proceed on the empty option, so it stays a
              disabled placeholder there; Catalog only needs it selectable, or a
              time column could be set and never removed again. */}
          <option value="" disabled={monitoring}>
            {preview
              ? monitoring
                ? 'Choose a time column'
                : 'No time column — read the whole query'
              : 'Load preview first'}
          </option>
          {timeColumnChoices.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        {monitoringPairIsNext && !state.timeColumn && (
          <p role="alert" className="mt-1.5 text-xs" style={{ color: 'var(--warning)' }}>
            {/* The select above is `disabled={!preview}` and reads "Load preview
                first", so "Pick a time column" pointed at a control the reader
                cannot use. An explicit Event type satisfies the blocker without
                a preview, and a saved never-dispatched config opens with none —
                both reach this branch. Name the step that IS available instead
                of dropping the warning, which would let a saved broken config
                open quiet. */}
            {preview
              ? 'Pick a time column — monitoring buckets metric points by it.'
              : 'Load a preview to choose a time column — monitoring needs one.'}
          </p>
        )}
      </Field>
      {monitoring && (
        <Field label="Schedule" id="scan-interval" hint="How often this scan runs." last={!preview}>
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
          {monitoringPairIsNext && !state.interval && (
            <p role="alert" className="mt-1.5 text-xs" style={{ color: 'var(--warning)' }}>
              Pick a schedule — monitoring needs one to record metric points.
            </p>
          )}
        </Field>
      )}

      {/* Last in the card, because it is the only thing here that is an ANSWER
          rather than a question — and because a dry run describes one specific
          draft. `toDryRunRequest` carries the time column (it is what the scan
          window is computed from), so with this panel above the Time column
          field, the sequence the form itself demands was: check → scroll down →
          pick the time column the form is asking for in red → and the answer
          just given turns to "The form changed since this check ran". Every
          monitoring scan, every time, until the user learns to ignore the one
          banner that also catches a genuinely broken event name format.
          Everything the request is built from that is still below this point
          lives in a collapsed section, where an edit is deliberate and staling
          the answer is the banner doing its job. */}
      {preview && (
        <div data-testid="scan-preview-panel" className="space-y-3 px-[18px] py-4">
          <ScanPreviewPanel
            preview={preview}
            dryRun={dryRun}
            dryRunStale={dryRunStale}
            dryRunPending={dryRunMut.isPending}
            dryRunError={dryRunMut.isError ? dryRunMut.error : null}
            eventTargetMissing={!hasEventTarget(state)}
            onRecheck={runDryRun}
          />
          {/* Directly under the answer it acts on, and driven by the same
              `unmapped_columns` the panel just listed — it used to sit hundreds
              of pixels higher, computing its own reserved set, so the two could
              and did disagree about the same columns on the same screen. Hidden
              while the answer is stale: those column names belong to the draft
              the dry run ran on, which is no longer this one. */}
          {dryRun && !dryRunStale && state.eventTypeId && (
            <CreateMissingFieldsButton
              slug={slug}
              eventType={eventTypes.find(et => et.id === state.eventTypeId)}
              preview={preview}
              unmappedColumns={dryRun.unmapped_columns}
              branchId={branchId}
            />
          )}
        </div>
      )}
    </SCard>
  )
}

export function EventNamingSection({ form, footerFor }: SectionProps) {
  const {
    state, set, preview,
    toggleJsonValuePath, discoverJsonMut,
  } = form
  // "Event type column" is no longer here — it is half of the essentials'
  // "where does the event name come from?" question, and burying the field a
  // scan cannot run without behind a header saying to leave it alone is what
  // made every default scan fail. What is left is genuinely optional, so the
  // header can promise that leaving it alone works and be telling the truth.
  const defaultOpen = Boolean(
    state.eventNameFormat
    || state.cardinalityThreshold !== 100
    || state.eventGroupRules.length
    || state.jsonValuePaths.length,
  )

  return (
    <CollapsibleSection
      title="Event names and grouping"
      explanation="Reshape the names tripl derives above — rewrite them from a template, collapse high-cardinality values, or merge several into one. Leave this alone and each name is used as it is."
      defaultOpen={defaultOpen}
      footer={footerFor?.()}
    >
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
  // Only count the two monitoring-only fields when they are on screen: a saved
  // chunk interval or metrics cap survives a switch to Catalog only (by design —
  // see toBackendPayload), and springing the section open to show neither of them
  // is a section that opens on nothing.
  const defaultOpen = Boolean(
    lookbackIsCustom
    || state.scanRowLimit
    || (monitoring && (state.chunkInterval || state.metricsRowLimit)),
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
      {/* A lookback is the predicate `<time column> >= now() - N hours`, so with
          no time column there is no window to set: resolve_lookback_window
          returns None and the run reads everything the base query returns.
          Offering the input anyway would be a control that states a bound and
          applies none, so the field is replaced by the one sentence that says
          what is actually happening and where to change it. */}
      {state.timeColumn ? (
        <Field
          label="Lookback (hours)"
          id="scan-lookback-hours"
          hint={`How far back each run reads, counted on ${state.timeColumn}. Default 24.`}
        >
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
      ) : (
        <Field label="Lookback (hours)">
          <p className="text-xs" style={{ color: 'var(--fg-subtle)' }}>
            {NO_LOOKBACK_WITHOUT_TIME_COLUMN}
          </p>
        </Field>
      )}
      <Field label="Row cap per run" id="scan-row-limit" last={!monitoring}>
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
      {/* A metrics run is `collect_metrics`, which the scheduler dispatches only
          for a config with both a schedule and a time column, so in Catalog only
          there are no metrics runs to cap — the same reason the breakdown section
          above is hidden outright rather than asked and ignored. Hidden, not
          cleared: `toBackendPayload` still sends `metrics_row_limit`, so a cap
          saved while monitoring survives a switch to Catalog only and comes back
          the moment monitoring does. */}
      {monitoring && (
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
      )}
    </CollapsibleSection>
  )
}
