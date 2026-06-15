import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { dataSourcesApi } from '@/api/dataSources'
import { eventTypesApi } from '@/api/eventTypes'
import { scansApi } from '@/api/scans'
import { useActiveBranchId } from '@/hooks/useBranch'
import type { DataSource, EventType, ScanConfigPreview } from '@/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ErrorState } from '@/components/error-state'
import { AppVersionFields } from './AppVersionFields'
import { CreateMissingFieldsButton } from './CreateMissingFieldsButton'
import { DistributionDriftPicker } from './DistributionDriftPicker'
import { EventGroupRulesEditor } from './EventGroupRulesEditor'
import { MetricBreakdownPicker } from './MetricBreakdownPicker'
import { ScanPreviewPanel } from './ScanPreviewPanel'
import {
  type UiEventGroupRule,
  stripUiIds,
} from './scanFormTypes'
import type { IntervalCode } from '@/types'
import {
  CHUNK_LABELS,
  SELECT_CLASS,
  eligibleChunkIntervals,
  parseOptionalPositiveInt,
} from './scanUtils'
export { ScanEditDialog } from './ScanEditDialog'

// ─── Create Dialog ───────────────────────────────────────────────────────────

export function ScanCreateDialog({
  slug,
  open,
  onClose,
}: {
  slug: string
  open: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const branchId = useActiveBranchId()

  const [dsId, setDsId] = useState('')
  const [scanName, setScanName] = useState('')
  const [baseQuery, setBaseQuery] = useState('')
  const [eventTypeId, setEventTypeId] = useState('')
  const [eventTypeColumn, setEventTypeColumn] = useState('')
  const [timeColumn, setTimeColumn] = useState('')
  const [appVersionColumn, setAppVersionColumn] = useState('')
  const [appVersionKeepReleases, setAppVersionKeepReleases] = useState('')
  const [eventNameFormat, setEventNameFormat] = useState('')
  const [jsonValuePaths, setJsonValuePaths] = useState<string[]>([])
  const [eventGroupRules, setEventGroupRules] = useState<UiEventGroupRule[]>([])
  const [metricBreakdownColumns, setMetricBreakdownColumns] = useState<string[]>([])
  const [metricBreakdownValuesLimit, setMetricBreakdownValuesLimit] = useState('')
  const [distributionDriftFields, setDistributionDriftFields] = useState<string[]>([])
  const [cardinalityThreshold, setCardinalityThreshold] = useState(100)
  const [interval, setInterval] = useState('')
  const [chunkInterval, setChunkInterval] = useState('')
  const [scanLookbackHours, setScanLookbackHours] = useState('24')
  const [scanRowLimit, setScanRowLimit] = useState('')
  const [metricsRowLimit, setMetricsRowLimit] = useState('')
  const [preview, setPreview] = useState<ScanConfigPreview | null>(null)

  const { data: dataSources = [] } = useQuery({
    queryKey: ['dataSources'],
    queryFn: () => dataSourcesApi.list(),
  })

  const { data: eventTypes = [] } = useQuery({
    queryKey: ['eventTypes', slug, branchId],
    queryFn: () => eventTypesApi.list(slug, branchId),
  })

  const resetForm = () => {
    onClose()
    setDsId(''); setScanName(''); setBaseQuery('')
    setEventTypeId(''); setEventTypeColumn('')
    setTimeColumn(''); setAppVersionColumn(''); setAppVersionKeepReleases('')
    setEventNameFormat('')
    setJsonValuePaths([]); setMetricBreakdownColumns([])
    setEventGroupRules([])
    setDistributionDriftFields([])
    setMetricBreakdownValuesLimit(''); setPreview(null)
    setCardinalityThreshold(100); setInterval(''); setChunkInterval('')
    setScanLookbackHours('24'); setScanRowLimit(''); setMetricsRowLimit('')
  }

  const createMut = useMutation({
    mutationFn: () =>
      scansApi.create(slug, {
        data_source_id: dsId,
        name: scanName,
        base_query: baseQuery,
        event_type_id: eventTypeId || null,
        event_type_column: eventTypeColumn || null,
        time_column: timeColumn || null,
        event_name_format: eventNameFormat || null,
        json_value_paths: jsonValuePaths,
        event_group_rules: stripUiIds(eventGroupRules),
        metric_breakdown_columns: metricBreakdownColumns,
        metric_breakdown_values_limit: metricBreakdownValuesLimit ? Number(metricBreakdownValuesLimit) : null,
        distribution_drift_fields: distributionDriftFields,
        app_version_column: appVersionColumn || null,
        app_version_keep_releases: appVersionColumn ? parseOptionalPositiveInt(appVersionKeepReleases) : null,
        cardinality_threshold: cardinalityThreshold,
        interval: interval || null,
        replay_chunk_interval: chunkInterval || null,
        scan_lookback_hours: parseOptionalPositiveInt(scanLookbackHours),
        scan_row_limit: parseOptionalPositiveInt(scanRowLimit),
        metrics_row_limit: parseOptionalPositiveInt(metricsRowLimit),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scans', slug] })
      resetForm()
    },
  })

  const previewMut = useMutation({
    mutationFn: () => scansApi.preview(slug, {
      data_source_id: dsId,
      base_query: baseQuery,
      limit: 10,
      time_column: timeColumn || null,
      scan_lookback_hours: parseOptionalPositiveInt(scanLookbackHours),
    }),
    onSuccess: data => {
      setPreview(data)
      if (!data.columns.some(column => column.name === eventTypeColumn)) setEventTypeColumn('')
      if (!data.columns.some(column => column.name === timeColumn)) setTimeColumn('')
      if (!data.columns.some(column => column.name === appVersionColumn)) {
        setAppVersionColumn('')
        setAppVersionKeepReleases('')
      }
      setMetricBreakdownColumns(current =>
        current.filter(column =>
          data.columns.some(item => item.name === column)
          && column !== eventTypeColumn
          && column !== timeColumn
          && column !== appVersionColumn,
        ),
      )
      setDistributionDriftFields(current =>
        current.filter(field =>
          data.columns.some(item => item.name === field)
          && field !== eventTypeColumn
          && field !== timeColumn
          && field !== appVersionColumn,
        ),
      )
    },
  })

  // JSON path discovery is the slow half of the preview, so it runs as its own
  // job behind an explicit "Discover JSON keys" action; merge the result into
  // the already-loaded fast preview.
  const discoverJsonMut = useMutation({
    mutationFn: () => scansApi.preview(slug, {
      data_source_id: dsId,
      base_query: baseQuery,
      json_value_paths: jsonValuePaths,
      time_column: timeColumn || null,
      scan_lookback_hours: parseOptionalPositiveInt(scanLookbackHours),
      include_json_paths: true,
    }),
    onSuccess: data => {
      // Discard a discovery result that resolves after the preview was reset
      // (e.g. base query changed mid-flight) — merging into a null preview would
      // drop columns/rows and crash the panel.
      setPreview(current => (current ? { ...current, json_columns: data.json_columns } : current))
    },
  })

  const toggleJsonValuePath = (path: string) => {
    setJsonValuePaths(current =>
      current.includes(path) ? current.filter(item => item !== path) : [...current, path],
    )
  }

  const toggleMetricBreakdownColumn = (column: string) => {
    setMetricBreakdownColumns(current =>
      current.includes(column) ? current.filter(item => item !== column) : [...current, column],
    )
  }

  const toggleDistributionDriftField = (field: string) => {
    setDistributionDriftFields(current =>
      current.includes(field) ? current.filter(item => item !== field) : [...current, field],
    )
  }

  const handleAppVersionColumnChange = (column: string) => {
    setAppVersionColumn(column)
    setMetricBreakdownColumns(current => current.filter(item => item !== column))
    setDistributionDriftFields(current => current.filter(item => item !== column))
    if (!column) setAppVersionKeepReleases('')
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) resetForm(); else onClose() }}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] max-w-4xl flex-col overflow-hidden p-0">
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={e => { e.preventDefault(); createMut.mutate() }}>
          <DialogHeader className="px-6 pt-6"><DialogTitle>New Scan Config</DialogTitle></DialogHeader>
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-6 py-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2"><Label>Name</Label><Input value={scanName} onChange={e => setScanName(e.target.value)} required placeholder="e.g. Main events scan" /></div>
              <div className="grid gap-2">
                <Label>Data Source</Label>
                <select value={dsId} onChange={e => { setDsId(e.target.value); setPreview(null); setJsonValuePaths([]); setDistributionDriftFields([]); discoverJsonMut.reset() }} className={SELECT_CLASS} required>
                  <option value="">Select…</option>
                  {dataSources.map((ds: DataSource) => <option key={ds.id} value={ds.id}>{ds.name}</option>)}
                </select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Base Query (used as subquery)</Label>
              <Textarea
                value={baseQuery}
                onChange={e => { setBaseQuery(e.target.value); setPreview(null); setJsonValuePaths([]); setDistributionDriftFields([]); discoverJsonMut.reset() }}
                className="font-mono text-sm"
                rows={4}
                required
                placeholder="SELECT * FROM analytics.events"
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border bg-muted/20 p-3">
              <div>
                <div className="text-sm font-medium">Preview query</div>
                <p className="text-xs text-muted-foreground">
                  Load sample rows first, then choose columns and JSON paths from the preview.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => { discoverJsonMut.reset(); previewMut.mutate() }}
                disabled={previewMut.isPending || !dsId || !baseQuery.trim()}
              >
                {previewMut.isPending ? 'Loading…' : 'Load Preview'}
              </Button>
            </div>
            {previewMut.isError && (
              <ErrorState compact title="Preview failed" error={previewMut.error} />
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Event Type (optional)</Label>
                <select value={eventTypeId} onChange={e => setEventTypeId(e.target.value)} className={SELECT_CLASS}>
                  <option value="">Auto-detect</option>
                  {eventTypes.map((et: EventType) => <option key={et.id} value={et.id}>{et.display_name}</option>)}
                </select>
              </div>
              <div className="grid gap-2">
                <Label>Event Type Column (optional)</Label>
                <select
                  value={eventTypeColumn}
                  onChange={e => {
                    const next = e.target.value
                    setEventTypeColumn(next)
                    setMetricBreakdownColumns(current => current.filter(column => column !== next))
                    setDistributionDriftFields(current => current.filter(field => field !== next))
                  }}
                  className={SELECT_CLASS}
                  disabled={!preview}
                >
                  <option value="">{preview ? 'No grouping' : 'Load preview first'}</option>
                  {preview?.columns.map(column => (
                    <option key={column.name} value={column.name}>{column.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Time Column (optional)</Label>
                <select
                  value={timeColumn}
                  onChange={e => {
                    const next = e.target.value
                    setTimeColumn(next)
                    setMetricBreakdownColumns(current => current.filter(column => column !== next))
                    setDistributionDriftFields(current => current.filter(field => field !== next))
                  }}
                  className={SELECT_CLASS}
                  disabled={!preview}
                >
                  <option value="">{preview ? 'No time series' : 'Load preview first'}</option>
                  {preview?.columns.map(column => (
                    <option key={column.name} value={column.name}>{column.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2"><Label>Event Name Format (optional)</Label><Input value={eventNameFormat} onChange={e => setEventNameFormat(e.target.value)} placeholder="e.g. {action}:{category}" /></div>
            </div>
            <AppVersionFields
              columns={preview?.columns ?? null}
              appVersionColumn={appVersionColumn}
              keepReleases={appVersionKeepReleases}
              onAppVersionColumnChange={handleAppVersionColumnChange}
              onKeepReleasesChange={setAppVersionKeepReleases}
            />
            {preview && eventTypeId && (
              <CreateMissingFieldsButton
                slug={slug}
                eventType={eventTypes.find((et: EventType) => et.id === eventTypeId)}
                preview={preview}
                eventTypeColumn={eventTypeColumn}
                timeColumn={timeColumn}
                branchId={branchId}
              />
            )}
            {preview && (
              <ScanPreviewPanel
                preview={preview}
                selectedJsonValuePaths={jsonValuePaths}
                onToggleJsonValuePath={toggleJsonValuePath}
                onDiscoverJsonPaths={() => discoverJsonMut.mutate()}
                isDiscoveringJsonPaths={discoverJsonMut.isPending}
                jsonPathsError={discoverJsonMut.error}
                jsonPathsDiscovered={discoverJsonMut.isSuccess}
              />
            )}
            {preview && (
              <MetricBreakdownPicker
                columns={preview.columns}
                selectedColumns={metricBreakdownColumns}
                eventTypeColumn={eventTypeColumn}
                timeColumn={timeColumn}
                appVersionColumn={appVersionColumn}
                valuesLimit={metricBreakdownValuesLimit}
                onToggleColumn={toggleMetricBreakdownColumn}
                onValuesLimitChange={setMetricBreakdownValuesLimit}
              />
            )}
            {preview && (
              <DistributionDriftPicker
                columns={preview.columns}
                selectedFields={distributionDriftFields}
                eventTypeColumn={eventTypeColumn}
                timeColumn={timeColumn}
                appVersionColumn={appVersionColumn}
                onToggleField={toggleDistributionDriftField}
              />
            )}
            <EventGroupRulesEditor
              rules={eventGroupRules}
              columns={preview?.columns}
              onChange={setEventGroupRules}
            />
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2"><Label>Cardinality Threshold</Label><Input type="number" value={cardinalityThreshold} onChange={e => setCardinalityThreshold(Number(e.target.value))} min={1} /></div>
              <div className="grid gap-2">
                <Label>Collection Interval</Label>
                <select
                  value={interval}
                  onChange={e => {
                    const next = e.target.value
                    setInterval(next)
                    if (chunkInterval && !eligibleChunkIntervals(next).includes(chunkInterval as IntervalCode)) {
                      setChunkInterval('')
                    }
                  }}
                  className={SELECT_CLASS}
                >
                  <option value="">No schedule</option>
                  <option value="15m">Every 15 min</option>
                  <option value="1h">Every hour</option>
                  <option value="6h">Every 6 hours</option>
                  <option value="1d">Every day</option>
                  <option value="1w">Every week</option>
                </select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label>Scan Lookback, h</Label>
                <Input type="number" value={scanLookbackHours} onChange={e => setScanLookbackHours(e.target.value)} min={1} placeholder="Default" />
              </div>
              <div className="grid gap-2">
                <Label>Scan Row Cap</Label>
                <Input type="number" value={scanRowLimit} onChange={e => setScanRowLimit(e.target.value)} min={1} placeholder="Default" />
              </div>
              <div className="grid gap-2">
                <Label>Metrics Row Cap</Label>
                <Input type="number" value={metricsRowLimit} onChange={e => setMetricsRowLimit(e.target.value)} min={1} placeholder="Default" />
              </div>
            </div>
            {interval && (
              <div className="grid gap-2">
                <Label>Replay Chunk Size</Label>
                <select value={chunkInterval} onChange={e => setChunkInterval(e.target.value)} className={SELECT_CLASS}>
                  <option value="">Whole window (no split)</option>
                  {eligibleChunkIntervals(interval).map(code => (
                    <option key={code} value={code}>{CHUNK_LABELS[code]}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Splits a long replay into smaller warehouse queries so it doesn't time out. Must be ≥ the collection interval.
                </p>
              </div>
            )}
            {createMut.isError && (
              <ErrorState compact title="Could not create scan config" error={createMut.error} />
            )}
          </div>
          <DialogFooter className="shrink-0 border-t bg-background px-6 py-4">
            <Button type="button" variant="outline" onClick={resetForm}>Cancel</Button>
            <Button type="submit" disabled={createMut.isPending}>Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
