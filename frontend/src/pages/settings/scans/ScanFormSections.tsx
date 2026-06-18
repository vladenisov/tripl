import { Play } from 'lucide-react'
import type { DataSource, EventType, IntervalCode } from '@/types'
import { toSQLNamespace, useDataSourceSchema } from '@/hooks/useDataSourceSchema'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorState } from '@/components/error-state'
import { AppVersionFields } from './AppVersionFields'
import { CreateMissingFieldsButton } from './CreateMissingFieldsButton'
import { DistributionDriftPicker } from './DistributionDriftPicker'
import { EventGroupRulesEditor } from './EventGroupRulesEditor'
import { MetricBreakdownPicker } from './MetricBreakdownPicker'
import { ScanPreviewPanel } from './ScanPreviewPanel'
import { SqlEditor } from './SqlEditor'
import { Field, SCard } from './scanLayout'
import { CHUNK_LABELS, SELECT_CLASS, eligibleChunkIntervals } from './scanUtils'
import type { UseScanFormResult } from './useScanForm'

const INTERVAL_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'No schedule (manual)' },
  { value: '15m', label: 'Every 15 min' },
  { value: '1h', label: 'Every hour' },
  { value: '6h', label: 'Every 6 hours' },
  { value: '1d', label: 'Every day' },
  { value: '1w', label: 'Every week' },
]

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

export function SourceQuerySection({
  form,
  dataSources,
  sourceLocked,
  footerFor,
}: SectionProps) {
  const { state, set, setBaseQuery, setDataSourceId, previewMut, discoverJsonMut } = form
  const selectedSource = dataSources.find(ds => ds.id === state.dataSourceId)
  const sourceName = selectedSource?.name ?? ''
  const { data: schemaData } = useDataSourceSchema(state.dataSourceId || undefined)
  const sqlNamespace = schemaData ? toSQLNamespace(schemaData.tables) : undefined
  return (
    <SCard title="Source & query" footer={footerFor?.()}>
      <Field label="Name">
        <Input
          value={state.name}
          onChange={e => set('name', e.target.value)}
          placeholder="e.g. Main events scan"
        />
      </Field>
      <Field label="Data source">
        {sourceLocked ? (
          <Input value={sourceName} disabled className="max-w-[280px]" />
        ) : (
          <select
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
          value={state.baseQuery}
          onChange={setBaseQuery}
          placeholder="SELECT * FROM analytics.events"
          dialect={selectedSource?.db_type}
          schema={sqlNamespace}
        />
      </Field>
      <Field
        label="Preview"
        hint="Load sample rows, then pick columns and JSON paths from the result."
        last
      >
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => { discoverJsonMut.reset(); previewMut.mutate() }}
            disabled={previewMut.isPending || !state.dataSourceId || !state.baseQuery.trim()}
          >
            <Play className="size-3" />
            {previewMut.isPending ? 'Loading…' : form.preview ? 'Reload preview' : 'Load preview'}
          </Button>
          {previewMut.isError && <ErrorState compact title="Preview failed" error={previewMut.error} />}
        </div>
      </Field>
    </SCard>
  )
}

export function EventMappingSection({
  form,
  slug,
  branchId,
  eventTypes,
  footerFor,
}: SectionProps) {
  const {
    state, set, preview,
    setEventTypeColumn, setTimeColumn,
  } = form
  return (
    <SCard title="Event mapping" footer={footerFor?.()}>
      <Field label="Event type" hint="Leave on auto-detect to derive from the data.">
        <select
          value={state.eventTypeId}
          onChange={e => set('eventTypeId', e.target.value)}
          className={`${SELECT_CLASS} max-w-[280px]`}
        >
          <option value="">Auto-detect</option>
          {eventTypes.map(et => <option key={et.id} value={et.id}>{et.display_name}</option>)}
        </select>
      </Field>
      <Field label="Event type column">
        <select
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
      <Field label="Time column">
        <select
          value={state.timeColumn}
          onChange={e => setTimeColumn(e.target.value)}
          className={`${SELECT_CLASS} max-w-[280px]`}
          disabled={!preview}
        >
          <option value="">{preview ? 'No time series' : 'Load preview first'}</option>
          {preview?.columns.map(column => (
            <option key={column.name} value={column.name}>{column.name}</option>
          ))}
        </select>
      </Field>
      <Field label="Event name format" hint="Template, e.g. {action}:{category}." last>
        <Input
          value={state.eventNameFormat}
          onChange={e => set('eventNameFormat', e.target.value)}
          className="font-mono max-w-[280px]"
          placeholder="{action}"
        />
      </Field>
      {preview && state.eventTypeId && (
        <div className="px-[18px] pb-4">
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
    </SCard>
  )
}

export function AppVersionSection({ form, footerFor }: SectionProps) {
  const { state, setAppVersionColumn, set, preview } = form
  return (
    <SCard
      title="App version"
      description="Track adoption and keep recent releases for distribution metrics."
      footer={footerFor?.()}
    >
      <div className="px-[18px] py-4">
        <AppVersionFields
          columns={preview?.columns ?? null}
          appVersionColumn={state.appVersionColumn}
          keepReleases={state.appVersionKeepReleases}
          onAppVersionColumnChange={setAppVersionColumn}
          onKeepReleasesChange={value => set('appVersionKeepReleases', value)}
        />
      </div>
    </SCard>
  )
}

export function MetricsDriftSection({ form, footerFor }: SectionProps) {
  const {
    state, set, preview,
    toggleJsonValuePath, toggleMetricBreakdownColumn, toggleDistributionDriftField,
    discoverJsonMut,
  } = form

  if (!preview) {
    return (
      <SCard title="Metrics & drift" footer={footerFor?.()}>
        <Field label="Breakdowns, drift & JSON paths" last>
          <p className="text-xs" style={{ color: 'var(--fg-faint)' }}>
            Load a preview to choose breakdown columns, distribution drift fields and JSON paths.
          </p>
        </Field>
      </SCard>
    )
  }

  return (
    <SCard title="Metrics & drift" footer={footerFor?.()}>
      <div className="space-y-4 px-[18px] py-4">
        <MetricBreakdownPicker
          columns={preview.columns}
          selectedColumns={state.metricBreakdownColumns}
          eventTypeColumn={state.eventTypeColumn}
          timeColumn={state.timeColumn}
          appVersionColumn={state.appVersionColumn}
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
          onToggleField={toggleDistributionDriftField}
        />
        <ScanPreviewPanel
          preview={preview}
          selectedJsonValuePaths={state.jsonValuePaths}
          onToggleJsonValuePath={toggleJsonValuePath}
          onDiscoverJsonPaths={() => discoverJsonMut.mutate()}
          isDiscoveringJsonPaths={discoverJsonMut.isPending}
          jsonPathsError={discoverJsonMut.error}
          jsonPathsDiscovered={discoverJsonMut.isSuccess}
        />
        <EventGroupRulesEditor
          rules={state.eventGroupRules}
          columns={preview.columns}
          onChange={rules => set('eventGroupRules', rules)}
        />
        <div className="grid max-w-[280px] gap-1.5">
          <label className="text-[13px] font-medium" style={{ color: 'var(--fg)' }}>
            Cardinality threshold
          </label>
          <Input
            type="number"
            min={1}
            value={state.cardinalityThreshold}
            onChange={e => set('cardinalityThreshold', Number(e.target.value))}
            className="font-mono"
          />
        </div>
      </div>
    </SCard>
  )
}

export function ScheduleLimitsSection({ form, footerFor }: SectionProps) {
  const { state, set, setInterval } = form
  return (
    <SCard title="Schedule & limits" footer={footerFor?.()}>
      <Field label="Collection interval">
        <select
          value={state.interval}
          onChange={e => setInterval(e.target.value)}
          className={`${SELECT_CLASS} max-w-[280px]`}
        >
          {INTERVAL_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </Field>
      {state.interval && (
        <Field
          label="Replay chunk size"
          hint="Splits long replays into smaller warehouse queries. Must be ≥ the interval."
        >
          <select
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
      <Field label="Scan lookback (h)">
        <Input
          type="number"
          min={1}
          value={state.scanLookbackHours}
          onChange={e => set('scanLookbackHours', e.target.value)}
          className="font-mono max-w-[280px]"
          placeholder="Default"
        />
      </Field>
      <Field label="Scan row cap">
        <Input
          type="number"
          min={1}
          value={state.scanRowLimit}
          onChange={e => set('scanRowLimit', e.target.value)}
          className="font-mono max-w-[280px]"
          placeholder="Default"
        />
      </Field>
      <Field label="Metrics row cap" last>
        <Input
          type="number"
          min={1}
          value={state.metricsRowLimit}
          onChange={e => set('metricsRowLimit', e.target.value)}
          className="font-mono max-w-[280px]"
          placeholder="Default"
        />
      </Field>
    </SCard>
  )
}
