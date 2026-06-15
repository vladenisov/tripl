import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { eventTypesApi } from '@/api/eventTypes'
import { scansApi } from '@/api/scans'
import { useActiveBranchId } from '@/hooks/useBranch'
import type { EventType, IntervalCode, ScanConfig, ScanConfigPreview } from '@/types'
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
  withUiIds,
} from './scanFormTypes'
import {
  CHUNK_LABELS,
  SELECT_CLASS,
  eligibleChunkIntervals,
  parseOptionalPositiveInt,
} from './scanUtils'

export function ScanEditDialog({
  slug,
  scanConfig,
  onClose,
}: {
  slug: string
  scanConfig: ScanConfig | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const branchId = useActiveBranchId()

  const [editName, setEditName] = useState(scanConfig?.name ?? '')
  const [editBaseQuery, setEditBaseQuery] = useState(scanConfig?.base_query ?? '')
  const [editEventTypeId, setEditEventTypeId] = useState(scanConfig?.event_type_id ?? '')
  const [editEventTypeColumn, setEditEventTypeColumn] = useState(scanConfig?.event_type_column ?? '')
  const [editTimeColumn, setEditTimeColumn] = useState(scanConfig?.time_column ?? '')
  const [editAppVersionColumn, setEditAppVersionColumn] = useState(scanConfig?.app_version_column ?? '')
  const [editAppVersionKeepReleases, setEditAppVersionKeepReleases] = useState(
    scanConfig?.app_version_keep_releases ? String(scanConfig.app_version_keep_releases) : '',
  )
  const [editEventNameFormat, setEditEventNameFormat] = useState(scanConfig?.event_name_format ?? '')
  const [editJsonValuePaths, setEditJsonValuePaths] = useState<string[]>(scanConfig?.json_value_paths ?? [])
  const [editEventGroupRules, setEditEventGroupRules] = useState<UiEventGroupRule[]>(
    withUiIds(scanConfig?.event_group_rules ?? []),
  )
  const [editMetricBreakdownColumns, setEditMetricBreakdownColumns] = useState<string[]>(
    scanConfig?.metric_breakdown_columns ?? [],
  )
  const [editMetricBreakdownValuesLimit, setEditMetricBreakdownValuesLimit] = useState(
    scanConfig?.metric_breakdown_values_limit ? String(scanConfig.metric_breakdown_values_limit) : '',
  )
  const [editDistributionDriftFields, setEditDistributionDriftFields] = useState<string[]>(
    scanConfig?.distribution_drift_fields ?? [],
  )
  const [editCardinalityThreshold, setEditCardinalityThreshold] = useState(
    scanConfig?.cardinality_threshold ?? 100,
  )
  const [editInterval, setEditInterval] = useState(scanConfig?.interval ?? '')
  const [editChunkInterval, setEditChunkInterval] = useState(scanConfig?.replay_chunk_interval ?? '')
  const [editScanLookbackHours, setEditScanLookbackHours] = useState(
    scanConfig?.scan_lookback_hours == null ? '' : String(scanConfig.scan_lookback_hours),
  )
  const [editScanRowLimit, setEditScanRowLimit] = useState(
    scanConfig?.scan_row_limit == null ? '' : String(scanConfig.scan_row_limit),
  )
  const [editMetricsRowLimit, setEditMetricsRowLimit] = useState(
    scanConfig?.metrics_row_limit == null ? '' : String(scanConfig.metrics_row_limit),
  )
  const [editPreview, setEditPreview] = useState<ScanConfigPreview | null>(null)

  const { data: eventTypes = [] } = useQuery({
    queryKey: ['eventTypes', slug, branchId],
    queryFn: () => eventTypesApi.list(slug, branchId),
  })

  const updateMut = useMutation({
    mutationFn: () =>
      scansApi.update(slug, scanConfig!.id, {
        name: editName,
        base_query: editBaseQuery,
        event_type_id: editEventTypeId || null,
        event_type_column: editEventTypeColumn || null,
        time_column: editTimeColumn || null,
        event_name_format: editEventNameFormat || null,
        json_value_paths: editJsonValuePaths,
        event_group_rules: stripUiIds(editEventGroupRules),
        metric_breakdown_columns: editMetricBreakdownColumns,
        metric_breakdown_values_limit: editMetricBreakdownValuesLimit ? Number(editMetricBreakdownValuesLimit) : null,
        distribution_drift_fields: editDistributionDriftFields,
        app_version_column: editAppVersionColumn || null,
        app_version_keep_releases: editAppVersionColumn ? parseOptionalPositiveInt(editAppVersionKeepReleases) : null,
        cardinality_threshold: editCardinalityThreshold,
        interval: editInterval || null,
        replay_chunk_interval: editChunkInterval || null,
        scan_lookback_hours: parseOptionalPositiveInt(editScanLookbackHours),
        scan_row_limit: parseOptionalPositiveInt(editScanRowLimit),
        metrics_row_limit: parseOptionalPositiveInt(editMetricsRowLimit),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scans', slug] })
      onClose()
    },
  })

  const editPreviewMut = useMutation({
    mutationFn: () => {
      if (!scanConfig) throw new Error('Missing scan config')
      return scansApi.preview(slug, {
        data_source_id: scanConfig.data_source_id,
        base_query: editBaseQuery,
        limit: 10,
        time_column: editTimeColumn || null,
        scan_lookback_hours: parseOptionalPositiveInt(editScanLookbackHours),
      })
    },
    onSuccess: data => {
      setEditPreview(data)
      if (!data.columns.some(column => column.name === editEventTypeColumn)) setEditEventTypeColumn('')
      if (!data.columns.some(column => column.name === editTimeColumn)) setEditTimeColumn('')
      if (!data.columns.some(column => column.name === editAppVersionColumn)) {
        setEditAppVersionColumn('')
        setEditAppVersionKeepReleases('')
      }
      setEditMetricBreakdownColumns(current =>
        current.filter(column =>
          data.columns.some(item => item.name === column)
          && column !== editEventTypeColumn
          && column !== editTimeColumn
          && column !== editAppVersionColumn,
        ),
      )
      setEditDistributionDriftFields(current =>
        current.filter(field =>
          data.columns.some(item => item.name === field)
          && field !== editEventTypeColumn
          && field !== editTimeColumn
          && field !== editAppVersionColumn,
        ),
      )
    },
  })

  // JSON path discovery is the slow half of the preview, so it runs as its own
  // job behind an explicit "Discover JSON keys" action; merge the result into
  // the already-loaded fast preview.
  const editDiscoverJsonMut = useMutation({
    mutationFn: () => {
      if (!scanConfig) throw new Error('Missing scan config')
      return scansApi.preview(slug, {
        data_source_id: scanConfig.data_source_id,
        base_query: editBaseQuery,
        json_value_paths: editJsonValuePaths,
        time_column: editTimeColumn || null,
        scan_lookback_hours: parseOptionalPositiveInt(editScanLookbackHours),
        include_json_paths: true,
      })
    },
    onSuccess: data => {
      // Discard a discovery result that resolves after the preview was reset
      // (e.g. base query changed mid-flight) — merging into a null preview would
      // drop columns/rows and crash the panel.
      setEditPreview(current => (current ? { ...current, json_columns: data.json_columns } : current))
    },
  })

  const toggleEditJsonValuePath = (path: string) => {
    setEditJsonValuePaths(current =>
      current.includes(path) ? current.filter(item => item !== path) : [...current, path],
    )
  }

  const toggleEditMetricBreakdownColumn = (column: string) => {
    setEditMetricBreakdownColumns(current =>
      current.includes(column) ? current.filter(item => item !== column) : [...current, column],
    )
  }

  const toggleEditDistributionDriftField = (field: string) => {
    setEditDistributionDriftFields(current =>
      current.includes(field) ? current.filter(item => item !== field) : [...current, field],
    )
  }

  const handleEditAppVersionColumnChange = (column: string) => {
    setEditAppVersionColumn(column)
    setEditMetricBreakdownColumns(current => current.filter(item => item !== column))
    setEditDistributionDriftFields(current => current.filter(item => item !== column))
    if (!column) setEditAppVersionKeepReleases('')
  }

  return (
    <Dialog open={!!scanConfig} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] max-w-4xl flex-col overflow-hidden p-0">
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={e => { e.preventDefault(); if (scanConfig) updateMut.mutate() }}>
          <DialogHeader className="px-6 pt-6"><DialogTitle>Edit Scan Config</DialogTitle></DialogHeader>
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-6 py-4">
            <div className="grid gap-2"><Label>Name</Label><Input value={editName} onChange={e => setEditName(e.target.value)} /></div>
            <div className="grid gap-2">
              <Label>Base Query (used as subquery)</Label>
              <Textarea
                value={editBaseQuery}
                onChange={e => { setEditBaseQuery(e.target.value); setEditPreview(null); setEditDistributionDriftFields([]); editDiscoverJsonMut.reset() }}
                className="font-mono text-sm"
                rows={4}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border bg-muted/20 p-3">
              <div>
                <div className="text-sm font-medium">Preview query</div>
                <p className="text-xs text-muted-foreground">
                  Refresh preview to rebuild column pickers and JSON path options from sample rows.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => { editDiscoverJsonMut.reset(); editPreviewMut.mutate() }}
                disabled={editPreviewMut.isPending || !editBaseQuery.trim()}
              >
                {editPreviewMut.isPending ? 'Loading…' : 'Load Preview'}
              </Button>
            </div>
            {editPreviewMut.isError && (
              <ErrorState compact title="Preview failed" error={editPreviewMut.error} />
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Event Type (optional)</Label>
                <select value={editEventTypeId} onChange={e => setEditEventTypeId(e.target.value)} className={SELECT_CLASS}>
                  <option value="">Auto-detect</option>
                  {eventTypes.map((et: EventType) => <option key={et.id} value={et.id}>{et.display_name}</option>)}
                </select>
              </div>
              <div className="grid gap-2">
                <Label>Event Type Column (optional)</Label>
                <select
                  value={editEventTypeColumn}
                  onChange={e => {
                    const next = e.target.value
                    setEditEventTypeColumn(next)
                    setEditMetricBreakdownColumns(current => current.filter(column => column !== next))
                    setEditDistributionDriftFields(current => current.filter(field => field !== next))
                  }}
                  className={SELECT_CLASS}
                  disabled={!editPreview}
                >
                  <option value="">{editPreview ? 'No grouping' : 'Load preview first'}</option>
                  {editPreview?.columns.map(column => (
                    <option key={column.name} value={column.name}>{column.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Time Column (optional)</Label>
                <select
                  value={editTimeColumn}
                  onChange={e => {
                    const next = e.target.value
                    setEditTimeColumn(next)
                    setEditMetricBreakdownColumns(current => current.filter(column => column !== next))
                    setEditDistributionDriftFields(current => current.filter(field => field !== next))
                  }}
                  className={SELECT_CLASS}
                  disabled={!editPreview}
                >
                  <option value="">{editPreview ? 'No time series' : 'Load preview first'}</option>
                  {editPreview?.columns.map(column => (
                    <option key={column.name} value={column.name}>{column.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2"><Label>Event Name Format (optional)</Label><Input value={editEventNameFormat} onChange={e => setEditEventNameFormat(e.target.value)} placeholder="e.g. {action}:{category}" /></div>
            </div>
            <AppVersionFields
              columns={editPreview?.columns ?? null}
              appVersionColumn={editAppVersionColumn}
              keepReleases={editAppVersionKeepReleases}
              onAppVersionColumnChange={handleEditAppVersionColumnChange}
              onKeepReleasesChange={setEditAppVersionKeepReleases}
            />
            {editPreview && editEventTypeId && (
              <CreateMissingFieldsButton
                slug={slug}
                eventType={eventTypes.find((et: EventType) => et.id === editEventTypeId)}
                preview={editPreview}
                eventTypeColumn={editEventTypeColumn}
                timeColumn={editTimeColumn}
                branchId={branchId}
              />
            )}
            {editPreview && (
              <ScanPreviewPanel
                preview={editPreview}
                selectedJsonValuePaths={editJsonValuePaths}
                onToggleJsonValuePath={toggleEditJsonValuePath}
                onDiscoverJsonPaths={() => editDiscoverJsonMut.mutate()}
                isDiscoveringJsonPaths={editDiscoverJsonMut.isPending}
                jsonPathsError={editDiscoverJsonMut.error}
                jsonPathsDiscovered={editDiscoverJsonMut.isSuccess}
              />
            )}
            {editPreview && (
              <MetricBreakdownPicker
                columns={editPreview.columns}
                selectedColumns={editMetricBreakdownColumns}
                eventTypeColumn={editEventTypeColumn}
                timeColumn={editTimeColumn}
                appVersionColumn={editAppVersionColumn}
                valuesLimit={editMetricBreakdownValuesLimit}
                onToggleColumn={toggleEditMetricBreakdownColumn}
                onValuesLimitChange={setEditMetricBreakdownValuesLimit}
              />
            )}
            {editPreview && (
              <DistributionDriftPicker
                columns={editPreview.columns}
                selectedFields={editDistributionDriftFields}
                eventTypeColumn={editEventTypeColumn}
                timeColumn={editTimeColumn}
                appVersionColumn={editAppVersionColumn}
                onToggleField={toggleEditDistributionDriftField}
              />
            )}
            <EventGroupRulesEditor
              rules={editEventGroupRules}
              columns={editPreview?.columns}
              onChange={setEditEventGroupRules}
            />
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2"><Label>Cardinality Threshold</Label><Input type="number" value={editCardinalityThreshold} onChange={e => setEditCardinalityThreshold(Number(e.target.value))} min={1} /></div>
              <div className="grid gap-2">
                <Label>Collection Interval</Label>
                <select
                  value={editInterval}
                  onChange={e => {
                    const next = e.target.value
                    setEditInterval(next)
                    if (editChunkInterval && !eligibleChunkIntervals(next).includes(editChunkInterval as IntervalCode)) {
                      setEditChunkInterval('')
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
                <Input type="number" value={editScanLookbackHours} onChange={e => setEditScanLookbackHours(e.target.value)} min={1} placeholder="Default" />
              </div>
              <div className="grid gap-2">
                <Label>Scan Row Cap</Label>
                <Input type="number" value={editScanRowLimit} onChange={e => setEditScanRowLimit(e.target.value)} min={1} placeholder="Default" />
              </div>
              <div className="grid gap-2">
                <Label>Metrics Row Cap</Label>
                <Input type="number" value={editMetricsRowLimit} onChange={e => setEditMetricsRowLimit(e.target.value)} min={1} placeholder="Default" />
              </div>
            </div>
            {editInterval && (
              <div className="grid gap-2">
                <Label>Replay Chunk Size</Label>
                <select value={editChunkInterval} onChange={e => setEditChunkInterval(e.target.value)} className={SELECT_CLASS}>
                  <option value="">Whole window (no split)</option>
                  {eligibleChunkIntervals(editInterval).map(code => (
                    <option key={code} value={code}>{CHUNK_LABELS[code]}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Splits a long replay into smaller warehouse queries so it doesn't time out. Must be ≥ the collection interval.
                </p>
              </div>
            )}
            {updateMut.isError && (
              <ErrorState compact title="Could not save scan config" error={updateMut.error} />
            )}
          </div>
          <DialogFooter className="shrink-0 border-t bg-background px-6 py-4">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={updateMut.isPending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
