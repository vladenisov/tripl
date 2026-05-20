import { Fragment, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, Pencil, Play, Plus, RotateCcw, Search, Trash2 } from "lucide-react"
import { dataSourcesApi } from "@/api/dataSources"
import { eventTypesApi } from "@/api/eventTypes"
import { scansApi } from "@/api/scans"
import type {
  DataSource,
  EventType,
  ScanConfig,
  ScanConfigPreview,
  ScanJob,
} from "@/types"
import { useConfirm } from "@/hooks/useConfirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState } from "@/components/empty-state"

function formatPreviewCell(value: unknown): string {
  if (value == null) return '—'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function ScanPreviewPanel({
  preview,
  selectedJsonValuePaths,
  onToggleJsonValuePath,
}: {
  preview: ScanConfigPreview
  selectedJsonValuePaths: string[]
  onToggleJsonValuePath: (path: string) => void
}) {
  return (
    <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <div className="space-y-1">
        <div className="text-sm font-medium">Preview</div>
        <p className="text-xs text-muted-foreground">
          Column pickers and JSON path options are built from this sample. Rows are picked from a larger fetch to show more variety when possible.
        </p>
      </div>

      <div className="rounded-lg border bg-background overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {preview.columns.map(column => (
                <TableHead key={column.name}>{column.name}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {preview.rows.slice(0, 5).map((row, index) => (
              <TableRow key={index}>
                {preview.columns.map(column => (
                  <TableCell key={column.name} className="max-w-[220px] truncate text-xs">
                    {formatPreviewCell(row[column.name])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {preview.json_columns.some(column => column.paths.length > 0) && (
        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium">JSON values to keep as-is</div>
            <p className="text-xs text-muted-foreground">
              Selected paths stay as real values in generated JSON. Unselected paths become variables.
            </p>
          </div>
          <div className="space-y-3">
            {preview.json_columns.map(jsonColumn => (
              <div key={jsonColumn.column} className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {jsonColumn.column}
                </div>
                {jsonColumn.paths.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No nested paths found in sample.</div>
                ) : (
                  <div className="grid gap-2">
                    {jsonColumn.paths.map(path => (
                      <label key={path.full_path} className="flex items-start gap-2 rounded-md border bg-background p-2 text-sm">
                        <Checkbox
                          checked={selectedJsonValuePaths.includes(path.full_path)}
                          onCheckedChange={() => onToggleJsonValuePath(path.full_path)}
                        />
                        <span className="space-y-1">
                          <span className="block font-mono text-xs">{path.path}</span>
                          {path.sample_values.length > 0 && (
                            <span className="block text-xs text-muted-foreground">
                              sample: {path.sample_values.join(', ')}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function isJsonPreviewType(typeName: string) {
  return typeName.toLowerCase().includes('json')
}

function MetricBreakdownPicker({
  columns,
  selectedColumns,
  eventTypeColumn,
  timeColumn,
  valuesLimit,
  onToggleColumn,
  onValuesLimitChange,
}: {
  columns: ScanConfigPreview['columns']
  selectedColumns: string[]
  eventTypeColumn: string
  timeColumn: string
  valuesLimit: string
  onToggleColumn: (column: string) => void
  onValuesLimitChange: (value: string) => void
}) {
  const availableColumns = columns.filter(column => !isJsonPreviewType(column.type_name))
  const reservedColumns = new Set([eventTypeColumn, timeColumn].filter(Boolean))

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Metric breakdowns</div>
          <p className="text-xs text-muted-foreground">
            Each selected scalar column is collected as a separate database-level grouping.
          </p>
        </div>
        <div className="grid w-40 gap-1">
          <Label className="text-xs">Value limit</Label>
          <Input
            type="number"
            min={1}
            value={valuesLimit}
            onChange={e => onValuesLimitChange(e.target.value)}
            placeholder="Unlimited"
            className="h-8"
          />
        </div>
      </div>
      {selectedColumns.length > 0 && !valuesLimit && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Unlimited breakdowns can be expensive for high-cardinality columns. Set a limit to keep top values and aggregate the rest into Other.
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {availableColumns.map(column => {
          const disabled = reservedColumns.has(column.name)
          return (
            <label
              key={column.name}
              className="flex items-center gap-2 rounded-md border bg-background p-2 text-sm"
            >
              <Checkbox
                checked={selectedColumns.includes(column.name)}
                disabled={disabled}
                onCheckedChange={() => {
                  if (!disabled) onToggleColumn(column.name)
                }}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{column.name}</span>
              {disabled && <Badge variant="outline" className="text-[10px]">reserved</Badge>}
            </label>
          )
        })}
      </div>
      {availableColumns.length === 0 && (
        <p className="text-xs text-muted-foreground">No scalar columns found in preview.</p>
      )}
    </div>
  )
}

function DistributionDriftPicker({
  columns,
  selectedFields,
  eventTypeColumn,
  timeColumn,
  onToggleField,
}: {
  columns: ScanConfigPreview['columns']
  selectedFields: string[]
  eventTypeColumn: string
  timeColumn: string
  onToggleField: (field: string) => void
}) {
  const availableColumns = columns.filter(column => !isJsonPreviewType(column.type_name))
  const reservedColumns = new Set([eventTypeColumn, timeColumn].filter(Boolean))

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div>
        <div className="text-sm font-medium">Distribution drift</div>
        <p className="text-xs text-muted-foreground">
          Selected scalar fields are compared against their rolling baseline with PSI.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {availableColumns.map(column => {
          const disabled = reservedColumns.has(column.name)
          return (
            <label
              key={column.name}
              className="flex items-center gap-2 rounded-md border bg-background p-2 text-sm"
            >
              <Checkbox
                checked={selectedFields.includes(column.name)}
                disabled={disabled}
                aria-label={`Distribution ${column.name}`}
                onCheckedChange={() => {
                  if (!disabled) onToggleField(column.name)
                }}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{column.name}</span>
              {disabled && <Badge variant="outline" className="text-[10px]">reserved</Badge>}
            </label>
          )
        })}
      </div>
      {availableColumns.length === 0 && (
        <p className="text-xs text-muted-foreground">No scalar columns found in preview.</p>
      )}
    </div>
  )
}

/* ─── Scans Tab ─── */
export function ScansTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingScanId, setEditingScanId] = useState<string | null>(null)
  const [preview, setPreview] = useState<ScanConfigPreview | null>(null)
  const [editPreview, setEditPreview] = useState<ScanConfigPreview | null>(null)
  const { confirm, dialog } = useConfirm()

  // Form state
  const [dsId, setDsId] = useState('')
  const [scanName, setScanName] = useState('')
  const [baseQuery, setBaseQuery] = useState('')
  const [eventTypeId, setEventTypeId] = useState('')
  const [eventTypeColumn, setEventTypeColumn] = useState('')
  const [timeColumn, setTimeColumn] = useState('')
  const [eventNameFormat, setEventNameFormat] = useState('')
  const [jsonValuePaths, setJsonValuePaths] = useState<string[]>([])
  const [metricBreakdownColumns, setMetricBreakdownColumns] = useState<string[]>([])
  const [metricBreakdownValuesLimit, setMetricBreakdownValuesLimit] = useState('')
  const [distributionDriftFields, setDistributionDriftFields] = useState<string[]>([])
  const [cardinalityThreshold, setCardinalityThreshold] = useState(100)
  const [interval, setInterval] = useState('')

  // Edit state
  const [editName, setEditName] = useState('')
  const [editBaseQuery, setEditBaseQuery] = useState('')
  const [editEventTypeId, setEditEventTypeId] = useState('')
  const [editEventTypeColumn, setEditEventTypeColumn] = useState('')
  const [editTimeColumn, setEditTimeColumn] = useState('')
  const [editEventNameFormat, setEditEventNameFormat] = useState('')
  const [editJsonValuePaths, setEditJsonValuePaths] = useState<string[]>([])
  const [editMetricBreakdownColumns, setEditMetricBreakdownColumns] = useState<string[]>([])
  const [editMetricBreakdownValuesLimit, setEditMetricBreakdownValuesLimit] = useState('')
  const [editDistributionDriftFields, setEditDistributionDriftFields] = useState<string[]>([])
  const [editCardinalityThreshold, setEditCardinalityThreshold] = useState(100)
  const [editInterval, setEditInterval] = useState('')

  const { data: dataSources = [] } = useQuery({
    queryKey: ['dataSources'],
    queryFn: () => dataSourcesApi.list(),
  })

  const { data: eventTypes = [] } = useQuery({
    queryKey: ['eventTypes', slug],
    queryFn: () => eventTypesApi.list(slug),
  })

  const { data: scanConfigs = [] } = useQuery({
    queryKey: ['scans', slug],
    queryFn: () => scansApi.list(slug),
  })

  const dsMap = new Map(dataSources.map((ds: DataSource) => [ds.id, ds.name]))

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
        metric_breakdown_columns: metricBreakdownColumns,
        metric_breakdown_values_limit: metricBreakdownValuesLimit ? Number(metricBreakdownValuesLimit) : null,
        distribution_drift_fields: distributionDriftFields,
        cardinality_threshold: cardinalityThreshold,
        interval: interval || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scans', slug] })
      resetForm()
    },
  })

  const updateMut = useMutation({
    mutationFn: (scanId: string) =>
      scansApi.update(slug, scanId, {
        name: editName,
        base_query: editBaseQuery,
        event_type_id: editEventTypeId || null,
        event_type_column: editEventTypeColumn || null,
        time_column: editTimeColumn || null,
        event_name_format: editEventNameFormat || null,
        json_value_paths: editJsonValuePaths,
        metric_breakdown_columns: editMetricBreakdownColumns,
        metric_breakdown_values_limit: editMetricBreakdownValuesLimit ? Number(editMetricBreakdownValuesLimit) : null,
        distribution_drift_fields: editDistributionDriftFields,
        cardinality_threshold: editCardinalityThreshold,
        interval: editInterval || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scans', slug] })
      setEditingScanId(null)
    },
  })

  const previewMut = useMutation({
    mutationFn: () => scansApi.preview(slug, {
      data_source_id: dsId,
      base_query: baseQuery,
      limit: 10,
    }),
    onSuccess: data => {
      setPreview(data)
      if (!data.columns.some(column => column.name === eventTypeColumn)) setEventTypeColumn('')
      if (!data.columns.some(column => column.name === timeColumn)) setTimeColumn('')
      setMetricBreakdownColumns(current =>
        current.filter(column =>
          data.columns.some(item => item.name === column)
          && column !== eventTypeColumn
          && column !== timeColumn,
        ),
      )
      setDistributionDriftFields(current =>
        current.filter(field =>
          data.columns.some(item => item.name === field)
          && field !== eventTypeColumn
          && field !== timeColumn,
        ),
      )
    },
  })

  const editPreviewMut = useMutation({
    mutationFn: () => {
      const scanConfig = scanConfigs.find(scan => scan.id === editingScanId)
      if (!scanConfig) throw new Error('Missing scan config')
      return scansApi.preview(slug, {
        data_source_id: scanConfig.data_source_id,
        base_query: editBaseQuery,
        limit: 10,
      })
    },
    onSuccess: data => {
      setEditPreview(data)
      if (!data.columns.some(column => column.name === editEventTypeColumn)) setEditEventTypeColumn('')
      if (!data.columns.some(column => column.name === editTimeColumn)) setEditTimeColumn('')
      setEditMetricBreakdownColumns(current =>
        current.filter(column =>
          data.columns.some(item => item.name === column)
          && column !== editEventTypeColumn
          && column !== editTimeColumn,
        ),
      )
      setEditDistributionDriftFields(current =>
        current.filter(field =>
          data.columns.some(item => item.name === field)
          && field !== editEventTypeColumn
          && field !== editTimeColumn,
        ),
      )
    },
  })

  const deleteMut = useMutation({
    mutationFn: (scanId: string) => scansApi.del(slug, scanId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scans', slug] }),
  })

  const handleDelete = async (sc: ScanConfig) => {
    const ok = await confirm({
      title: 'Delete scan config',
      message: `Delete "${sc.name}"?`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(sc.id)
  }

  const startEditScan = (sc: ScanConfig) => {
    setEditingScanId(sc.id)
    setEditName(sc.name)
    setEditBaseQuery(sc.base_query)
    setEditEventTypeId(sc.event_type_id ?? '')
    setEditEventTypeColumn(sc.event_type_column ?? '')
    setEditTimeColumn(sc.time_column ?? '')
    setEditEventNameFormat(sc.event_name_format ?? '')
    setEditJsonValuePaths(sc.json_value_paths ?? [])
    setEditMetricBreakdownColumns(sc.metric_breakdown_columns ?? [])
    setEditMetricBreakdownValuesLimit(sc.metric_breakdown_values_limit ? String(sc.metric_breakdown_values_limit) : '')
    setEditDistributionDriftFields(sc.distribution_drift_fields ?? [])
    setEditCardinalityThreshold(sc.cardinality_threshold)
    setEditInterval(sc.interval ?? '')
    setEditPreview(null)
  }

  const resetForm = () => {
    setShowForm(false)
    setDsId(''); setScanName(''); setBaseQuery('')
    setEventTypeId(''); setEventTypeColumn('')
    setTimeColumn(''); setEventNameFormat('')
    setJsonValuePaths([]); setMetricBreakdownColumns([])
    setDistributionDriftFields([])
    setMetricBreakdownValuesLimit(''); setPreview(null)
    setCardinalityThreshold(100); setInterval('')
  }

  const toggleJsonValuePath = (path: string) => {
    setJsonValuePaths(current =>
      current.includes(path)
        ? current.filter(item => item !== path)
        : [...current, path],
    )
  }

  const toggleEditJsonValuePath = (path: string) => {
    setEditJsonValuePaths(current =>
      current.includes(path)
        ? current.filter(item => item !== path)
        : [...current, path],
    )
  }

  const toggleMetricBreakdownColumn = (column: string) => {
    setMetricBreakdownColumns(current =>
      current.includes(column)
        ? current.filter(item => item !== column)
        : [...current, column],
    )
  }

  const toggleEditMetricBreakdownColumn = (column: string) => {
    setEditMetricBreakdownColumns(current =>
      current.includes(column)
        ? current.filter(item => item !== column)
        : [...current, column],
    )
  }

  const toggleDistributionDriftField = (field: string) => {
    setDistributionDriftFields(current =>
      current.includes(field)
        ? current.filter(item => item !== field)
        : [...current, field],
    )
  }

  const toggleEditDistributionDriftField = (field: string) => {
    setEditDistributionDriftFields(current =>
      current.includes(field)
        ? current.filter(item => item !== field)
        : [...current, field],
    )
  }

  const selectClass = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"

  return (
    <div className="space-y-4">
      {dialog}
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Scan Configs</h2>
        <Button onClick={() => setShowForm(true)} disabled={dataSources.length === 0}
          title={dataSources.length === 0 ? 'Add a data source first' : ''}>
          <Plus className="mr-2 h-4 w-4" />Add Scan Config
        </Button>
      </div>

      {dataSources.length === 0 && (
        <EmptyState icon={Search} title="No data sources" description="Add a data source connection first (via the global Data Sources page) to create scan configs." />
      )}

      {/* Create dialog */}
      <Dialog open={showForm} onOpenChange={v => { if (!v) resetForm(); else setShowForm(true) }}>
        <DialogContent className="flex max-h-[calc(100vh-2rem)] max-w-4xl flex-col overflow-hidden p-0">
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={e => { e.preventDefault(); createMut.mutate() }}>
            <DialogHeader className="px-6 pt-6"><DialogTitle>New Scan Config</DialogTitle></DialogHeader>
            <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-6 py-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2"><Label>Name</Label><Input value={scanName} onChange={e => setScanName(e.target.value)} required placeholder="e.g. Main events scan" /></div>
                <div className="grid gap-2">
                  <Label>Data Source</Label>
                  <select value={dsId} onChange={e => { setDsId(e.target.value); setPreview(null); setJsonValuePaths([]); setDistributionDriftFields([]) }} className={selectClass} required>
                    <option value="">Select…</option>
                    {dataSources.map((ds: DataSource) => <option key={ds.id} value={ds.id}>{ds.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid gap-2">
                <Label>Base Query (used as subquery)</Label>
                <Textarea
                  value={baseQuery}
                  onChange={e => { setBaseQuery(e.target.value); setPreview(null); setJsonValuePaths([]); setDistributionDriftFields([]) }}
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
                  onClick={() => previewMut.mutate()}
                  disabled={previewMut.isPending || !dsId || !baseQuery.trim()}
                >
                  {previewMut.isPending ? 'Loading…' : 'Load Preview'}
                </Button>
              </div>
              {previewMut.isError && (
                <p className="text-sm text-destructive">{(previewMut.error as Error).message}</p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>Event Type (optional)</Label>
                  <select value={eventTypeId} onChange={e => setEventTypeId(e.target.value)} className={selectClass}>
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
                    className={selectClass}
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
                    className={selectClass}
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
              {preview && (
                <ScanPreviewPanel
                  preview={preview}
                  selectedJsonValuePaths={jsonValuePaths}
                  onToggleJsonValuePath={toggleJsonValuePath}
                />
              )}
              {preview && (
                <MetricBreakdownPicker
                  columns={preview.columns}
                  selectedColumns={metricBreakdownColumns}
                  eventTypeColumn={eventTypeColumn}
                  timeColumn={timeColumn}
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
                  onToggleField={toggleDistributionDriftField}
                />
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2"><Label>Cardinality Threshold</Label><Input type="number" value={cardinalityThreshold} onChange={e => setCardinalityThreshold(Number(e.target.value))} min={1} /></div>
                <div className="grid gap-2">
                  <Label>Collection Interval</Label>
                  <select value={interval} onChange={e => setInterval(e.target.value)} className={selectClass}>
                    <option value="">No schedule</option>
                    <option value="15m">Every 15 min</option>
                    <option value="1h">Every hour</option>
                    <option value="6h">Every 6 hours</option>
                    <option value="1d">Every day</option>
                    <option value="1w">Every week</option>
                  </select>
                </div>
              </div>
              {createMut.isError && <p className="text-sm text-destructive">{(createMut.error as Error).message}</p>}
            </div>
            <DialogFooter className="shrink-0 border-t bg-background px-6 py-4">
              <Button type="button" variant="outline" onClick={resetForm}>Cancel</Button>
              <Button type="submit" disabled={createMut.isPending}>Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingScanId} onOpenChange={v => { if (!v) { setEditingScanId(null); setEditPreview(null) } }}>
        <DialogContent className="flex max-h-[calc(100vh-2rem)] max-w-4xl flex-col overflow-hidden p-0">
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={e => { e.preventDefault(); if (editingScanId) updateMut.mutate(editingScanId) }}>
            <DialogHeader className="px-6 pt-6"><DialogTitle>Edit Scan Config</DialogTitle></DialogHeader>
            <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-6 py-4">
              <div className="grid gap-2"><Label>Name</Label><Input value={editName} onChange={e => setEditName(e.target.value)} /></div>
              <div className="grid gap-2">
                <Label>Base Query (used as subquery)</Label>
                <Textarea
                  value={editBaseQuery}
                  onChange={e => { setEditBaseQuery(e.target.value); setEditPreview(null); setEditDistributionDriftFields([]) }}
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
                  onClick={() => editPreviewMut.mutate()}
                  disabled={editPreviewMut.isPending || !editBaseQuery.trim()}
                >
                  {editPreviewMut.isPending ? 'Loading…' : 'Load Preview'}
                </Button>
              </div>
              {editPreviewMut.isError && (
                <p className="text-sm text-destructive">{(editPreviewMut.error as Error).message}</p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>Event Type (optional)</Label>
                  <select value={editEventTypeId} onChange={e => setEditEventTypeId(e.target.value)} className={selectClass}>
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
                    className={selectClass}
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
                    className={selectClass}
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
              {editPreview && (
                <ScanPreviewPanel
                  preview={editPreview}
                  selectedJsonValuePaths={editJsonValuePaths}
                  onToggleJsonValuePath={toggleEditJsonValuePath}
                />
              )}
              {editPreview && (
                <MetricBreakdownPicker
                  columns={editPreview.columns}
                  selectedColumns={editMetricBreakdownColumns}
                  eventTypeColumn={editEventTypeColumn}
                  timeColumn={editTimeColumn}
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
                  onToggleField={toggleEditDistributionDriftField}
                />
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2"><Label>Cardinality Threshold</Label><Input type="number" value={editCardinalityThreshold} onChange={e => setEditCardinalityThreshold(Number(e.target.value))} min={1} /></div>
                <div className="grid gap-2">
                  <Label>Collection Interval</Label>
                  <select value={editInterval} onChange={e => setEditInterval(e.target.value)} className={selectClass}>
                    <option value="">No schedule</option>
                    <option value="15m">Every 15 min</option>
                    <option value="1h">Every hour</option>
                    <option value="6h">Every 6 hours</option>
                    <option value="1d">Every day</option>
                    <option value="1w">Every week</option>
                  </select>
                </div>
              </div>
              {updateMut.isError && <p className="text-sm text-destructive">{(updateMut.error as Error).message}</p>}
            </div>
            <DialogFooter className="shrink-0 border-t bg-background px-6 py-4">
              <Button type="button" variant="outline" onClick={() => setEditingScanId(null)}>Cancel</Button>
              <Button type="submit" disabled={updateMut.isPending}>Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {scanConfigs.map((sc: ScanConfig) => (
        <Collapsible key={sc.id} open={expandedId === sc.id} onOpenChange={open => setExpandedId(open ? sc.id : null)}>
          <Card>
            <CollapsibleTrigger asChild>
              <div className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-3">
                  <span className="font-semibold">{sc.name}</span>
                  <span className="text-muted-foreground text-sm">{dsMap.get(sc.data_source_id) ?? 'Unknown'}</span>
                  {sc.interval && <Badge variant="outline" className="text-xs">⏱ {sc.interval}</Badge>}
                  {sc.json_value_paths.length > 0 && (
                    <Badge variant="outline" className="text-xs">JSON keep {sc.json_value_paths.length}</Badge>
                  )}
                  {sc.metric_breakdown_columns.length > 0 && (
                    <Badge variant="outline" className="text-xs">Breakdowns {sc.metric_breakdown_columns.length}</Badge>
                  )}
                  {sc.distribution_drift_fields.length > 0 && (
                    <Badge variant="outline" className="text-xs">Distribution {sc.distribution_drift_fields.length}</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="icon" className="h-7 w-7" title="Edit scan config" onClick={e => { e.stopPropagation(); startEditScan(sc) }}><Pencil className="h-3 w-3" /></Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={e => { e.stopPropagation(); handleDelete(sc) }}><Trash2 className="h-3 w-3" /></Button>
                  <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${expandedId === sc.id ? 'rotate-180' : ''}`} />
                </div>
              </div>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ScanDetail slug={slug} scanConfig={sc} eventTypes={eventTypes} />
            </CollapsibleContent>
          </Card>
        </Collapsible>
      ))}
    </div>
  )
}

function toDatetimeLocalValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function createDefaultReplayWindow() {
  const to = new Date()
  to.setMinutes(0, 0, 0)
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000)
  return {
    from: toDatetimeLocalValue(from),
    to: toDatetimeLocalValue(to),
  }
}

/* ─── Scan Detail (jobs) ─── */
function ScanDetail({ slug, scanConfig, eventTypes }: { slug: string; scanConfig: ScanConfig; eventTypes: EventType[] }) {
  const qc = useQueryClient()
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null)
  const [replayOpen, setReplayOpen] = useState(false)
  const [replayFrom, setReplayFrom] = useState('')
  const [replayTo, setReplayTo] = useState('')

  const etName = eventTypes.find((et: EventType) => et.id === scanConfig.event_type_id)?.display_name
  const canReplayMetrics = Boolean(scanConfig.time_column && scanConfig.interval)

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['scanJobs', slug, scanConfig.id],
    queryFn: () => scansApi.listJobs(slug, scanConfig.id),
    refetchInterval: 5000,
  })

  const runMut = useMutation({
    mutationFn: () => scansApi.run(slug, scanConfig.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scanJobs', slug, scanConfig.id] }),
  })

  const replayMut = useMutation({
    mutationFn: () => {
      if (!replayFrom || !replayTo) throw new Error('Select a period to replay')
      const from = new Date(replayFrom)
      const to = new Date(replayTo)
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new Error('Period dates are invalid')
      }
      if (from >= to) throw new Error('Start must be before end')
      return scansApi.replayMetrics(slug, scanConfig.id, {
        time_from: from.toISOString(),
        time_to: to.toISOString(),
      })
    },
    onSuccess: () => {
      setReplayOpen(false)
      qc.invalidateQueries({ queryKey: ['scanJobs', slug, scanConfig.id] })
      qc.invalidateQueries({ queryKey: ['scans', slug] })
    },
  })

  const openReplayDialog = () => {
    const defaultWindow = createDefaultReplayWindow()
    setReplayFrom(defaultWindow.from)
    setReplayTo(defaultWindow.to)
    setReplayOpen(true)
    replayMut.reset()
  }

  const statusVariant: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
    pending: 'outline',
    running: 'secondary',
    completed: 'default',
    failed: 'destructive',
  }

  return (
    <div className="border-t p-4 space-y-4">
      <Dialog open={replayOpen} onOpenChange={setReplayOpen}>
        <DialogContent>
          <form
            className="space-y-4"
            onSubmit={e => {
              e.preventDefault()
              replayMut.mutate()
            }}
          >
            <DialogHeader>
              <DialogTitle>Replay Metrics Period</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>From</Label>
                <Input
                  type="datetime-local"
                  value={replayFrom}
                  onChange={e => setReplayFrom(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label>To</Label>
                <Input
                  type="datetime-local"
                  value={replayTo}
                  onChange={e => setReplayTo(e.target.value)}
                  required
                />
              </div>
            </div>
            {replayMut.isError && <p className="text-sm text-destructive">{(replayMut.error as Error).message}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setReplayOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={replayMut.isPending}>
                <RotateCcw className="mr-1 h-3 w-3" />
                {replayMut.isPending ? 'Starting…' : 'Replay Period'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Query info panel */}
      <div className="rounded-lg border bg-muted/30 overflow-hidden">
        <div className="px-3 py-2 bg-muted/50 border-b flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Base Query (subquery)</span>
          <div className="flex gap-3 text-xs text-muted-foreground flex-wrap">
            <span>Threshold: <strong className="text-foreground">{scanConfig.cardinality_threshold}</strong></span>
            {scanConfig.event_type_column && <span>Group by: <strong className="text-foreground">{scanConfig.event_type_column}</strong></span>}
            {scanConfig.time_column && <span>Time col: <strong className="text-foreground">{scanConfig.time_column}</strong></span>}
            {scanConfig.event_name_format && <span>Name fmt: <strong className="text-foreground">{scanConfig.event_name_format}</strong></span>}
            {scanConfig.json_value_paths.length > 0 && (
              <span>JSON keep: <strong className="text-foreground">{scanConfig.json_value_paths.length}</strong></span>
            )}
            {scanConfig.metric_breakdown_columns.length > 0 && (
              <span>
                Breakdowns:
                <strong className="text-foreground">
                  {' '}
                  {scanConfig.metric_breakdown_columns.join(', ')}
                  {scanConfig.metric_breakdown_values_limit ? ` · top ${scanConfig.metric_breakdown_values_limit}` : ' · unlimited'}
                </strong>
              </span>
            )}
            {scanConfig.distribution_drift_fields.length > 0 && (
              <span>
                Distribution:
                <strong className="text-foreground">
                  {' '}
                  {scanConfig.distribution_drift_fields.join(', ')}
                </strong>
              </span>
            )}
            {etName && <span>Event Type: <strong className="text-foreground">{etName}</strong></span>}
            {scanConfig.interval && <span>Interval: <strong className="text-foreground">{scanConfig.interval}</strong></span>}
            <span>
              Monitoring:
              <strong className="text-foreground">
                {' '}
                {scanConfig.time_column && scanConfig.interval ? 'shared project settings' : 'requires time column + interval'}
              </strong>
            </span>
          </div>
        </div>
        <pre className="p-3 text-xs font-mono text-foreground/80 whitespace-pre-wrap overflow-x-auto">{scanConfig.base_query}</pre>
      </div>

      <div className="flex justify-between items-center">
        <h3 className="text-sm font-semibold">Jobs</h3>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={openReplayDialog}
            disabled={!canReplayMetrics || replayMut.isPending}
            title={canReplayMetrics ? 'Replay metrics for a past period' : 'Requires time column and interval'}
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            Replay Period
          </Button>
          <Button size="sm" onClick={() => runMut.mutate()} disabled={runMut.isPending}>
            <Play className="mr-1 h-3 w-3" />
            {runMut.isPending ? 'Starting…' : 'Run Scan'}
          </Button>
        </div>
      </div>

      {runMut.isError && <p className="text-sm text-destructive">{(runMut.error as Error).message}</p>}

      {isLoading && <p className="text-sm text-muted-foreground">Loading jobs…</p>}

      {jobs.length === 0 && !isLoading && (
        <p className="text-sm text-muted-foreground">No jobs yet. Click "Run Scan" to start.</p>
      )}

      {jobs.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="w-8"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job: ScanJob) => {
                const duration = job.started_at && job.completed_at
                  ? `${((new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 1000).toFixed(1)}s`
                  : job.started_at && job.status === 'running' ? 'running…' : '—'
                return (
                  <Fragment key={job.id}>
                  <TableRow>
                    <TableCell>
                      <Badge variant={statusVariant[job.status] ?? 'outline'} className="text-xs">{job.status}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {job.started_at ? new Date(job.started_at).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{duration}</TableCell>
                    <TableCell className="text-xs">
                      {job.status === 'failed' && (
                        <span className="text-destructive">{job.error_message}</span>
                      )}
                      {job.result_summary && (
                        <div className="flex gap-2">
                          {job.result_summary.events_created != null && (
                            <Badge variant="outline" className="text-[10px] text-green-600">+{job.result_summary.events_created} events</Badge>
                          )}
                          {job.result_summary.variables_created != null && job.result_summary.variables_created > 0 && (
                            <Badge variant="outline" className="text-[10px] text-blue-600">+{job.result_summary.variables_created} vars</Badge>
                          )}
                          {job.result_summary.events_skipped != null && job.result_summary.events_skipped > 0 && (
                            <Badge variant="outline" className="text-[10px]">{job.result_summary.events_skipped} skipped</Badge>
                          )}
                          {job.result_summary.signals_added != null && job.result_summary.signals_added > 0 && (
                            <Badge variant="outline" className="text-[10px] text-destructive">+{job.result_summary.signals_added} signals</Badge>
                          )}
                          {job.result_summary.signals_removed != null && job.result_summary.signals_removed > 0 && (
                            <Badge variant="outline" className="text-[10px] text-green-700">-{job.result_summary.signals_removed} signals</Badge>
                          )}
                          {job.result_summary.metrics_deleted != null && job.result_summary.metrics_deleted > 0 && (
                            <Badge variant="outline" className="text-[10px]">{job.result_summary.metrics_deleted} replaced</Badge>
                          )}
                          {job.result_summary.breakdown_event_metrics != null && job.result_summary.breakdown_event_metrics > 0 && (
                            <Badge variant="outline" className="text-[10px]">{job.result_summary.breakdown_event_metrics} breakdowns</Badge>
                          )}
                          {job.result_summary.distribution_drifts != null && job.result_summary.distribution_drifts > 0 && (
                            <Badge variant="outline" className="text-[10px]">{job.result_summary.distribution_drifts} drift rows</Badge>
                          )}
                          {job.result_summary.alerts_queued != null && job.result_summary.alerts_queued > 0 && (
                            <Badge variant="outline" className="text-[10px] text-amber-600">+{job.result_summary.alerts_queued} alerts</Badge>
                          )}
                          {job.result_summary.columns_analyzed != null && (
                            <span className="text-muted-foreground text-[10px]">{job.result_summary.columns_analyzed} cols</span>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {(job.result_summary || job.error_message) && (
                        <Button variant="ghost" size="icon" className="h-6 w-6"
                          onClick={() => setExpandedJobId(expandedJobId === job.id ? null : job.id)}>
                          <ChevronDown className={`h-3 w-3 transition-transform ${expandedJobId === job.id ? 'rotate-180' : ''}`} />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                  {expandedJobId === job.id && (
                    <TableRow>
                      <TableCell colSpan={5} className="p-0">
                        <div className="p-4 space-y-3 bg-muted/30">
                          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Job Details</h4>
                          {job.error_message && (
                            <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 text-xs text-destructive font-mono whitespace-pre-wrap">
                              {job.error_message}
                            </div>
                          )}
                          {job.result_summary && (
                            <div className="space-y-3">
                              {(job.result_summary.time_from || job.result_summary.time_to) && (
                                <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
                                  <span className="font-medium text-foreground">
                                    {job.result_summary.mode === 'metrics_replay' ? 'Replay period' : 'Collection period'}
                                  </span>
                                  {job.result_summary.time_from && job.result_summary.time_to && (
                                    <span> · {new Date(job.result_summary.time_from).toLocaleString()} - {new Date(job.result_summary.time_to).toLocaleString()}</span>
                                  )}
                                </div>
                              )}
                              <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-3 xl:grid-cols-5">
                              <Card className="p-3 text-center"><div className="text-lg font-bold text-green-600">{job.result_summary.events_created ?? 0}</div><div className="text-muted-foreground">Events created</div></Card>
                              <Card className="p-3 text-center"><div className="text-lg font-bold text-blue-600">{job.result_summary.variables_created ?? 0}</div><div className="text-muted-foreground">Variables created</div></Card>
                              <Card className="p-3 text-center"><div className="text-lg font-bold text-foreground">{job.result_summary.events_skipped ?? 0}</div><div className="text-muted-foreground">Events skipped</div></Card>
                              <Card className="p-3 text-center"><div className="text-lg font-bold text-primary">{job.result_summary.columns_analyzed ?? 0}</div><div className="text-muted-foreground">Columns analyzed</div></Card>
                              {job.result_summary.signals_added != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-destructive">{job.result_summary.signals_added}</div>
                                  <div className="text-muted-foreground">Signals added</div>
                                </Card>
                              )}
                              {job.result_summary.signals_removed != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-green-700">{job.result_summary.signals_removed}</div>
                                  <div className="text-muted-foreground">Signals removed</div>
                                </Card>
                              )}
                              {job.result_summary.metrics_deleted != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-foreground">{job.result_summary.metrics_deleted}</div>
                                  <div className="text-muted-foreground">Metrics replaced</div>
                                </Card>
                              )}
                              {job.result_summary.breakdown_event_metrics != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-foreground">{job.result_summary.breakdown_event_metrics}</div>
                                  <div className="text-muted-foreground">Event breakdowns</div>
                                </Card>
                              )}
                              {job.result_summary.breakdown_anomalies_detected != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-destructive">{job.result_summary.breakdown_anomalies_detected}</div>
                                  <div className="text-muted-foreground">Breakdown anomalies</div>
                                </Card>
                              )}
                              {job.result_summary.distribution_drifts != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-foreground">{job.result_summary.distribution_drifts}</div>
                                  <div className="text-muted-foreground">Distribution rows</div>
                                </Card>
                              )}
                              {job.result_summary.significant_distribution_drifts != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-destructive">{job.result_summary.significant_distribution_drifts}</div>
                                  <div className="text-muted-foreground">Distribution signals</div>
                                </Card>
                              )}
                              {job.result_summary.alerts_queued != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-amber-600">{job.result_summary.alerts_queued}</div>
                                  <div className="text-muted-foreground">Alerts queued</div>
                                </Card>
                              )}
                              </div>
                            </div>
                          )}
                          {job.result_summary?.details && job.result_summary.details.length > 0 && (
                            <div>
                              <h5 className="text-xs font-semibold text-muted-foreground mb-1">Log</h5>
                              <div className="rounded-lg border bg-background p-2 max-h-48 overflow-y-auto">
                                {job.result_summary.details.map((detail, i) => (
                                  <div key={i} className="text-xs font-mono text-muted-foreground py-0.5 border-b border-border/50 last:border-0">{detail}</div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
