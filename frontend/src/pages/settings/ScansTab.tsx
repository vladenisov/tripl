import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, Pencil, Plus, Search, Trash2 } from "lucide-react"
import { dataSourcesApi } from "@/api/dataSources"
import { eventTypesApi } from "@/api/eventTypes"
import { fieldsApi } from "@/api/fields"
import { scansApi } from "@/api/scans"
import type {
  DataSource,
  EventGroupRule,
  EventType,
  IntervalCode,
  ScanConfig,
  ScanConfigPreview,
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
import { ScanDetail } from "./ScanDetail"

function formatPreviewCell(value: unknown): string {
  if (value == null) return '—'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function splitFullJsonPath(fullPath: string): { column: string; path: string } | null {
  const separatorIndex = fullPath.indexOf('.')
  if (separatorIndex <= 0 || separatorIndex === fullPath.length - 1) return null
  return {
    column: fullPath.slice(0, separatorIndex),
    path: fullPath.slice(separatorIndex + 1),
  }
}

function jsonColumnsWithSelectedPaths(
  preview: ScanConfigPreview,
  selectedJsonValuePaths: string[],
): ScanConfigPreview['json_columns'] {
  const byColumn = new Map<string, ScanConfigPreview['json_columns'][number]>()

  preview.json_columns.forEach(jsonColumn => {
    byColumn.set(jsonColumn.column, {
      column: jsonColumn.column,
      paths: jsonColumn.paths.map(path => ({ ...path, sample_values: [...path.sample_values] })),
    })
  })

  selectedJsonValuePaths.forEach(fullPath => {
    const parsed = splitFullJsonPath(fullPath)
    if (!parsed) return

    const jsonColumn = byColumn.get(parsed.column) ?? { column: parsed.column, paths: [] }
    if (!jsonColumn.paths.some(path => path.full_path === fullPath)) {
      jsonColumn.paths.push({ full_path: fullPath, path: parsed.path, sample_values: [] })
    }
    byColumn.set(parsed.column, jsonColumn)
  })

  return Array.from(byColumn.values()).map(jsonColumn => ({
    ...jsonColumn,
    paths: [...jsonColumn.paths].sort((a, b) => a.path.localeCompare(b.path)),
  }))
}

// Ordered finest → coarsest. A replay chunk must be >= the collection interval,
// so eligible chunk sizes are the interval itself and anything coarser.
const INTERVAL_ORDER: IntervalCode[] = ['15m', '1h', '6h', '1d', '1w']
const CHUNK_LABELS: Record<IntervalCode, string> = {
  '15m': '15 minutes',
  '1h': '1 hour',
  '6h': '6 hours',
  '1d': '1 day',
  '1w': '1 week',
}

function eligibleChunkIntervals(interval: string): IntervalCode[] {
  const idx = INTERVAL_ORDER.indexOf(interval as IntervalCode)
  if (idx < 0) return []
  return INTERVAL_ORDER.slice(idx)
}

function parseOptionalPositiveInt(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

function emptyGroupRule(): EventGroupRule {
  return {
    name: '',
    condition_logic: 'all',
    conditions: [{ field: 'event_name', pattern: '' }],
  }
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
  const jsonColumns = jsonColumnsWithSelectedPaths(preview, selectedJsonValuePaths)

  return (
    <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <div className="space-y-1">
        <div className="text-sm font-medium">Preview</div>
        <p className="text-xs text-muted-foreground">
          Column pickers use the sample rows; JSON path options are discovered from the source query.
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

      {jsonColumns.some(column => column.paths.length > 0) && (
        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium">JSON values to keep as-is</div>
            <p className="text-xs text-muted-foreground">
              Selected paths stay as real values in generated JSON. Unselected paths become variables.
            </p>
          </div>
          <div className="space-y-3">
            {jsonColumns.map(jsonColumn => (
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

// When a scan targets an explicit event type, its base-query columns must exist as
// field definitions on that event type or the scan generates nothing. This derives the
// missing fields straight from the loaded preview so names always match the query.
function CreateMissingFieldsButton({
  slug,
  eventType,
  preview,
  eventTypeColumn,
  timeColumn,
}: {
  slug: string
  eventType: EventType | undefined
  preview: ScanConfigPreview | null
  eventTypeColumn: string
  timeColumn: string
}) {
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: (fields: { name: string; display_name: string; field_type: string }[]) =>
      fieldsApi.bulkCreate(slug, eventType!.id, fields),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eventTypes', slug] }),
  })

  if (!eventType || !preview) return null

  const reserved = new Set([eventTypeColumn, timeColumn].filter(Boolean))
  const existing = new Set(eventType.field_definitions.map(f => f.name))
  const missing = preview.columns.filter(c => !reserved.has(c.name) && !existing.has(c.name))

  return (
    <div className="flex items-center justify-between rounded-md border border-dashed bg-muted/10 px-3 py-2">
      <p className="text-xs text-muted-foreground">
        {missing.length === 0
          ? `All preview columns already exist as fields on "${eventType.display_name}".`
          : `${missing.length} preview column${missing.length === 1 ? '' : 's'} have no matching field on "${eventType.display_name}" — the scan will skip ${missing.length === 1 ? 'it' : 'them'}.`}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={missing.length === 0 || mutation.isPending}
        onClick={() =>
          mutation.mutate(
            missing.map(c => ({
              name: c.name,
              display_name: c.name,
              field_type: isJsonPreviewType(c.type_name) ? 'json' : 'string',
            })),
          )
        }
      >
        {mutation.isPending ? 'Creating…' : `Create ${missing.length} field${missing.length === 1 ? '' : 's'}`}
      </Button>
    </div>
  )
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

function EventGroupRulesEditor({
  rules,
  columns,
  onChange,
}: {
  rules: EventGroupRule[]
  columns?: ScanConfigPreview['columns']
  onChange: (rules: EventGroupRule[]) => void
}) {
  const fieldOptions = Array.from(
    new Set([
      'event_name',
      '__event_name',
      ...(columns ?? []).map(column => column.name),
      ...rules.flatMap(rule => rule.conditions.map(condition => condition.field).filter(Boolean)),
    ]),
  )

  const updateRule = (index: number, patch: Partial<EventGroupRule>) => {
    onChange(rules.map((rule, ruleIndex) => (
      ruleIndex === index ? { ...rule, ...patch } : rule
    )))
  }

  const updateCondition = (
    ruleIndex: number,
    conditionIndex: number,
    patch: Partial<EventGroupRule['conditions'][number]>,
  ) => {
    onChange(rules.map((rule, currentRuleIndex) => {
      if (currentRuleIndex !== ruleIndex) return rule
      return {
        ...rule,
        conditions: rule.conditions.map((condition, currentConditionIndex) => (
          currentConditionIndex === conditionIndex ? { ...condition, ...patch } : condition
        )),
      }
    }))
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Event groups</div>
          {!columns?.length && (
            <p className="text-xs text-muted-foreground">
              Load a preview to pick real columns; only event_name is available otherwise.
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...rules, emptyGroupRule()])}
        >
          <Plus className="mr-2 h-3 w-3" />Add Group Rule
        </Button>
      </div>
      {rules.length === 0 && (
        <p className="text-xs text-muted-foreground">No grouping rules.</p>
      )}
      {rules.map((rule, ruleIndex) => (
        <div key={ruleIndex} className="space-y-3 rounded-md border bg-background p-3">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
            <div className="grid gap-1">
              <Label>Group name</Label>
              <Input
                value={rule.name}
                onChange={event => updateRule(ruleIndex, { name: event.target.value })}
                placeholder="button events"
              />
            </div>
            <div className="grid gap-1">
              <Label>Match</Label>
              <select
                value={rule.condition_logic}
                onChange={event => updateRule(ruleIndex, {
                  condition_logic: event.target.value as EventGroupRule['condition_logic'],
                })}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              >
                <option value="all">All</option>
                <option value="any">Any</option>
              </select>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="self-end text-muted-foreground hover:text-destructive"
              title="Remove group rule"
              onClick={() => onChange(rules.filter((_, index) => index !== ruleIndex))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          <div className="space-y-2">
            {rule.conditions.map((condition, conditionIndex) => (
              <div key={conditionIndex} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <div className="grid gap-1">
                  <Label>Field</Label>
                  <select
                    value={condition.field}
                    onChange={event => updateCondition(ruleIndex, conditionIndex, {
                      field: event.target.value,
                    })}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  >
                    {fieldOptions.map(field => (
                      <option key={field} value={field}>{field}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-1">
                  <Label>Regex</Label>
                  <Input
                    value={condition.pattern}
                    onChange={event => updateCondition(ruleIndex, conditionIndex, {
                      pattern: event.target.value,
                    })}
                    placeholder="^button:"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="self-end text-muted-foreground hover:text-destructive"
                  title="Remove condition"
                  disabled={rule.conditions.length === 1}
                  onClick={() => updateRule(ruleIndex, {
                    conditions: rule.conditions.filter((_, index) => index !== conditionIndex),
                  })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => updateRule(ruleIndex, {
                conditions: [...rule.conditions, { field: 'event_name', pattern: '' }],
              })}
            >
              <Plus className="mr-2 h-3 w-3" />Add Condition
            </Button>
          </div>
        </div>
      ))}
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
  const [eventGroupRules, setEventGroupRules] = useState<EventGroupRule[]>([])
  const [metricBreakdownColumns, setMetricBreakdownColumns] = useState<string[]>([])
  const [metricBreakdownValuesLimit, setMetricBreakdownValuesLimit] = useState('')
  const [distributionDriftFields, setDistributionDriftFields] = useState<string[]>([])
  const [cardinalityThreshold, setCardinalityThreshold] = useState(100)
  const [interval, setInterval] = useState('')
  const [chunkInterval, setChunkInterval] = useState('')
  const [scanLookbackHours, setScanLookbackHours] = useState('24')
  const [scanRowLimit, setScanRowLimit] = useState('')
  const [metricsRowLimit, setMetricsRowLimit] = useState('')

  // Edit state
  const [editName, setEditName] = useState('')
  const [editBaseQuery, setEditBaseQuery] = useState('')
  const [editEventTypeId, setEditEventTypeId] = useState('')
  const [editEventTypeColumn, setEditEventTypeColumn] = useState('')
  const [editTimeColumn, setEditTimeColumn] = useState('')
  const [editEventNameFormat, setEditEventNameFormat] = useState('')
  const [editJsonValuePaths, setEditJsonValuePaths] = useState<string[]>([])
  const [editEventGroupRules, setEditEventGroupRules] = useState<EventGroupRule[]>([])
  const [editMetricBreakdownColumns, setEditMetricBreakdownColumns] = useState<string[]>([])
  const [editMetricBreakdownValuesLimit, setEditMetricBreakdownValuesLimit] = useState('')
  const [editDistributionDriftFields, setEditDistributionDriftFields] = useState<string[]>([])
  const [editCardinalityThreshold, setEditCardinalityThreshold] = useState(100)
  const [editInterval, setEditInterval] = useState('')
  const [editChunkInterval, setEditChunkInterval] = useState('')
  const [editScanLookbackHours, setEditScanLookbackHours] = useState('')
  const [editScanRowLimit, setEditScanRowLimit] = useState('')
  const [editMetricsRowLimit, setEditMetricsRowLimit] = useState('')

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
        event_group_rules: eventGroupRules,
        metric_breakdown_columns: metricBreakdownColumns,
        metric_breakdown_values_limit: metricBreakdownValuesLimit ? Number(metricBreakdownValuesLimit) : null,
        distribution_drift_fields: distributionDriftFields,
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
        event_group_rules: editEventGroupRules,
        metric_breakdown_columns: editMetricBreakdownColumns,
        metric_breakdown_values_limit: editMetricBreakdownValuesLimit ? Number(editMetricBreakdownValuesLimit) : null,
        distribution_drift_fields: editDistributionDriftFields,
        cardinality_threshold: editCardinalityThreshold,
        interval: editInterval || null,
        replay_chunk_interval: editChunkInterval || null,
        scan_lookback_hours: parseOptionalPositiveInt(editScanLookbackHours),
        scan_row_limit: parseOptionalPositiveInt(editScanRowLimit),
        metrics_row_limit: parseOptionalPositiveInt(editMetricsRowLimit),
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
      json_value_paths: jsonValuePaths,
      time_column: timeColumn || null,
      scan_lookback_hours: parseOptionalPositiveInt(scanLookbackHours),
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
        json_value_paths: editJsonValuePaths,
        time_column: editTimeColumn || null,
        scan_lookback_hours: parseOptionalPositiveInt(editScanLookbackHours),
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
    setEditEventGroupRules(sc.event_group_rules ?? [])
    setEditMetricBreakdownColumns(sc.metric_breakdown_columns ?? [])
    setEditMetricBreakdownValuesLimit(sc.metric_breakdown_values_limit ? String(sc.metric_breakdown_values_limit) : '')
    setEditDistributionDriftFields(sc.distribution_drift_fields ?? [])
    setEditCardinalityThreshold(sc.cardinality_threshold)
    setEditInterval(sc.interval ?? '')
    setEditChunkInterval(sc.replay_chunk_interval ?? '')
    setEditScanLookbackHours(sc.scan_lookback_hours == null ? '' : String(sc.scan_lookback_hours))
    setEditScanRowLimit(sc.scan_row_limit == null ? '' : String(sc.scan_row_limit))
    setEditMetricsRowLimit(sc.metrics_row_limit == null ? '' : String(sc.metrics_row_limit))
    setEditPreview(null)
  }

  const resetForm = () => {
    setShowForm(false)
    setDsId(''); setScanName(''); setBaseQuery('')
    setEventTypeId(''); setEventTypeColumn('')
    setTimeColumn(''); setEventNameFormat('')
    setJsonValuePaths([]); setMetricBreakdownColumns([])
    setEventGroupRules([])
    setDistributionDriftFields([])
    setMetricBreakdownValuesLimit(''); setPreview(null)
    setCardinalityThreshold(100); setInterval(''); setChunkInterval('')
    setScanLookbackHours('24'); setScanRowLimit(''); setMetricsRowLimit('')
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
              {preview && eventTypeId && (
                <CreateMissingFieldsButton
                  slug={slug}
                  eventType={eventTypes.find((et: EventType) => et.id === eventTypeId)}
                  preview={preview}
                  eventTypeColumn={eventTypeColumn}
                  timeColumn={timeColumn}
                />
              )}
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
                    className={selectClass}
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
                  <select value={chunkInterval} onChange={e => setChunkInterval(e.target.value)} className={selectClass}>
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
              {editPreview && editEventTypeId && (
                <CreateMissingFieldsButton
                  slug={slug}
                  eventType={eventTypes.find((et: EventType) => et.id === editEventTypeId)}
                  preview={editPreview}
                  eventTypeColumn={editEventTypeColumn}
                  timeColumn={editTimeColumn}
                />
              )}
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
                    className={selectClass}
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
                  <select value={editChunkInterval} onChange={e => setEditChunkInterval(e.target.value)} className={selectClass}>
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
                  {sc.scan_lookback_hours && (
                    <Badge variant="outline" className="text-xs">Lookback {sc.scan_lookback_hours}h</Badge>
                  )}
                  {sc.scan_row_limit && (
                    <Badge variant="outline" className="text-xs">Scan cap {sc.scan_row_limit}</Badge>
                  )}
                  {sc.metrics_row_limit && (
                    <Badge variant="outline" className="text-xs">Metrics cap {sc.metrics_row_limit}</Badge>
                  )}
                  {sc.json_value_paths.length > 0 && (
                    <Badge variant="outline" className="text-xs">JSON keep {sc.json_value_paths.length}</Badge>
                  )}
                  {sc.metric_breakdown_columns.length > 0 && (
                    <Badge variant="outline" className="text-xs">Breakdowns {sc.metric_breakdown_columns.length}</Badge>
                  )}
                  {sc.distribution_drift_fields.length > 0 && (
                    <Badge variant="outline" className="text-xs">Distribution {sc.distribution_drift_fields.length}</Badge>
                  )}
                  {sc.event_group_rules.length > 0 && (
                    <Badge variant="outline" className="text-xs">Groups {sc.event_group_rules.length}</Badge>
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
