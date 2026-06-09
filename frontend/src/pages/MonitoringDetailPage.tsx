import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { chartAnnotationsApi } from '@/api/chartAnnotations'
import { eventTypesApi } from '@/api/eventTypes'
import { eventsApi } from '@/api/events'
import { metaFieldsApi } from '@/api/metaFields'
import { metricsApi } from '@/api/metrics'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ErrorState } from '@/components/error-state'
import EventPhotosSection from '@/components/event-photos-section'
import { SeasonalityHeatmap } from '@/components/monitoring/seasonality-heatmap'
import { TopMoversPanel } from '@/components/monitoring/top-movers-panel'
import { VariableValueContextTrigger } from '@/components/variable-value-contexts'
import { MetricsChart, MetricsMultiSeriesChart } from '@/components/ui/chart'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useActiveBranchId } from '@/hooks/useBranch'
import { GRANULARITY_OPTIONS, RANGE_OPTIONS, aggregateMetricPoints, type MetricsGranularity } from '@/lib/metrics'
import { resolveMetaFieldHref } from '@/lib/metaFields'
import { routeScopeToApiScope } from '@/lib/monitoring'
import type {
  DistributionDriftBand,
  DistributionDriftPoint,
  EventType,
  FieldDefinition,
  MetaFieldDefinition,
} from '@/types'
import { AlertTriangle, ArrowLeft, CalendarPlus, CircleCheck, Eye, GitCompareArrows, Layers, Tag, Trash2 } from 'lucide-react'

export default function MonitoringDetailPage() {
  const { slug, scope: scopeParam, id, eventId } = useParams<{
    slug: string
    scope?: string
    id?: string
    eventId?: string
  }>()
  const navigate = useNavigate()
  const location = useLocation()
  // Return to wherever the user came from (e.g. an event-type tab with its filters),
  // not always the "all events" list. location.key is 'default' only when this page was
  // opened directly (deep link / refresh) with no in-app history to pop back to.
  const goBack = () => {
    if (location.key !== 'default') navigate(-1)
    else navigate(`/p/${slug}/events`)
  }
  const [rangeDays, setRangeDays] = useState(30)
  const [granularity, setGranularity] = useState<MetricsGranularity>('hour')
  const [activeTab, setActiveTab] = useState<'volume' | 'distribution' | 'heatmap' | 'breakdowns'>('volume')
  const [distributionField, setDistributionField] = useState('')
  const [breakdownColumn, setBreakdownColumn] = useState('')

  const branchId = useActiveBranchId()
  const scope = routeScopeToApiScope(scopeParam)
  const scopeId = id ?? eventId ?? ''

  const timeRange = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - rangeDays * 24 * 60 * 60 * 1000)
    return { from: from.toISOString(), to: to.toISOString() }
  }, [rangeDays])

  const eventQuery = useQuery({
    queryKey: ['event', slug, branchId, scopeId],
    queryFn: () => eventsApi.get(slug!, scopeId, branchId),
    enabled: scope === 'event' && !!slug && !!scopeId,
  })
  const event = eventQuery.data

  const eventTypesQuery = useQuery({
    queryKey: ['eventTypes', slug, branchId],
    queryFn: () => eventTypesApi.list(slug!, branchId),
    enabled: !!slug,
  })
  const eventTypes = eventTypesQuery.data ?? []

  const metaFieldsQuery = useQuery({
    queryKey: ['metaFields', slug, branchId],
    queryFn: () => metaFieldsApi.list(slug!, branchId),
    enabled: scope === 'event' && !!slug,
  })
  const metaFields = metaFieldsQuery.data ?? []

  const metricsQuery = useQuery({
    queryKey: ['monitoringMetrics', slug, scope, scopeId, rangeDays],
    queryFn: () => {
      if (scope === 'project_total') {
        return metricsApi.getProjectTotalMetrics(slug!, {
          scan_config_id: scopeId,
          ...timeRange,
        })
      }
      if (scope === 'event_type') {
        return metricsApi.getEventTypeMetrics(slug!, scopeId, timeRange)
      }
      return metricsApi.getEventMetrics(slug!, scopeId, timeRange)
    },
    enabled: !!slug && !!scopeId,
    refetchInterval: 60000,
  })
  const metrics = metricsQuery.data
  const eventDistributionEventTypeId = event?.event_type_id ?? null

  const distributionScope = useMemo(() => {
    if (scope === 'project_total' && scopeId) {
      return {
        scope_type: 'project_total' as const,
        scope_ref: scopeId,
        scan_config_id: scopeId,
      }
    }
    if (scope === 'event_type' && scopeId) {
      return {
        scope_type: 'event_type' as const,
        scope_ref: scopeId,
      }
    }
    if (scope === 'event' && eventDistributionEventTypeId) {
      return {
        scope_type: 'event_type' as const,
        scope_ref: eventDistributionEventTypeId,
      }
    }
    return null
  }, [eventDistributionEventTypeId, scope, scopeId])

  const distributionQuery = useQuery({
    queryKey: ['distributionDrifts', slug, distributionScope, rangeDays],
    queryFn: () => metricsApi.getDistributionDrifts(slug!, {
      scope_type: distributionScope!.scope_type,
      scope_ref: distributionScope!.scope_ref,
      scan_config_id: 'scan_config_id' in distributionScope!
        ? distributionScope!.scan_config_id
        : undefined,
      ...timeRange,
    }),
    enabled: activeTab === 'distribution' && !!slug && !!distributionScope,
    refetchInterval: 60000,
  })

  const chartData = useMemo(
    () => aggregateMetricPoints(metrics?.data ?? [], granularity),
    [granularity, metrics?.data],
  )

  // Breakdowns: split this event's volume into a series per value of a chosen column
  // (event-level only). Columns come from the event's configured breakdown columns plus
  // scan-wide breakdown columns that have collected data.
  const breakdownQuery = useQuery({
    queryKey: ['eventMetricBreakdowns', slug, scopeId, breakdownColumn, rangeDays],
    queryFn: () => metricsApi.getEventMetricBreakdowns(slug!, scopeId, {
      column: breakdownColumn || undefined,
      ...timeRange,
    }),
    enabled: scope === 'event' && activeTab === 'breakdowns' && !!slug && !!scopeId,
    refetchInterval: 60000,
  })
  const breakdowns = breakdownQuery.data
  const selectedBreakdownColumn = breakdownColumn || breakdowns?.selected_column || ''
  const breakdownChartSeries = useMemo(
    () => (breakdowns?.series ?? [])
      .slice(0, 8)
      .map(series => ({
        label: series.is_other ? 'Other' : (series.breakdown_value || '(empty)'),
        data: aggregateMetricPoints(series.data, granularity),
      })),
    [breakdowns?.series, granularity],
  )

  const queryClient = useQueryClient()
  const annotationsKey = ['chartAnnotations', slug, scope, scopeId, timeRange.from, timeRange.to]
  const annotationsQuery = useQuery({
    queryKey: annotationsKey,
    queryFn: () =>
      chartAnnotationsApi.list(slug!, {
        scope_type: scope,
        scope_ref: scopeId,
        from: timeRange.from,
        to: timeRange.to,
      }),
    enabled: !!slug && !!scopeId,
  })
  const annotations = annotationsQuery.data ?? []

  const [annotationBucket, setAnnotationBucket] = useState('')
  const [annotationLabel, setAnnotationLabel] = useState('')
  const createAnnotationMut = useMutation({
    mutationFn: () =>
      chartAnnotationsApi.create(slug!, {
        bucket: new Date(annotationBucket).toISOString(),
        label: annotationLabel.trim(),
        scope_type: scope,
        scope_ref: scopeId,
      }),
    onSuccess: () => {
      setAnnotationBucket('')
      setAnnotationLabel('')
      void queryClient.invalidateQueries({ queryKey: annotationsKey })
    },
  })
  const deleteAnnotationMut = useMutation({
    mutationFn: (id: string) => chartAnnotationsApi.delete(slug!, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: annotationsKey })
    },
  })

  const eventType = eventTypes.find((candidate: EventType) => (
    scope === 'event'
      ? candidate.id === event?.event_type_id
      : scope === 'event_type' && candidate.id === scopeId
  ))
  const fieldDefMap = new Map(
    (eventType?.field_definitions ?? []).map((field: FieldDefinition) => [field.id, field]),
  )
  const metaFieldMap = new Map(
    metaFields.map((metaField: MetaFieldDefinition) => [metaField.id, metaField]),
  )

  const headerTitle = (() => {
    if (scope === 'project_total') return 'Project Total'
    if (scope === 'event_type') return eventType?.display_name ?? 'Event Type'
    return event?.name ?? 'Event'
  })()
  const headerDescription = (() => {
    if (scope === 'project_total') return 'Canonical total event volume for the selected scan config.'
    if (scope === 'event_type') return eventType?.description || 'Aggregated volume for the event type.'
    return event?.description || 'Monitoring detail for the selected event.'
  })()
  const latestSignal = metrics?.latest_signal
  const latestSignalBadgeClassName = latestSignal?.state === 'recent'
    ? 'gap-1 border-amber-500/60 bg-amber-400/15 text-amber-800'
    : 'gap-1'
  const latestSignalLabel = latestSignal
    ? `${latestSignal.state === 'recent' ? 'Recent' : 'Latest scan'} ${latestSignal.direction === 'drop' ? 'drop' : 'spike'} anomaly`
    : null

  if (
    eventQuery.isError
    || eventTypesQuery.isError
    || metaFieldsQuery.isError
    || metricsQuery.isError
    || distributionQuery.isError
  ) {
    return (
      <div className="p-6">
        <ErrorState
          title="Failed to load monitoring details"
          description="The monitoring page could not fetch data from the backend."
          error={eventQuery.error ?? eventTypesQuery.error ?? metaFieldsQuery.error ?? metricsQuery.error ?? distributionQuery.error}
          onRetry={() => {
            const refetches: Promise<unknown>[] = [
              eventTypesQuery.refetch(),
              metricsQuery.refetch(),
            ]
            if (activeTab === 'distribution') {
              refetches.push(distributionQuery.refetch())
            }
            if (scope === 'event') {
              refetches.push(eventQuery.refetch(), metaFieldsQuery.refetch())
            }
            void Promise.all(refetches)
          }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6 max-w-5xl mx-auto">
      <Button variant="ghost" size="sm" onClick={goBack}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to events
      </Button>

      <div className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold">{headerTitle}</h1>
          {eventType && (
            <Badge style={{ backgroundColor: eventType.color, color: '#fff' }}>
              {eventType.display_name}
            </Badge>
          )}
          {scope === 'project_total' && metrics?.scan_config_id && (
            <Badge variant="outline" className="font-mono">
              {metrics.scan_config_id.slice(0, 8)}
            </Badge>
          )}
          {scope === 'event' && event?.implemented && (
            <Badge variant="outline" className="gap-1">
              <CircleCheck className="h-3 w-3" /> Implemented
            </Badge>
          )}
          {scope === 'event' && event?.reviewed && (
            <Badge variant="outline" className="gap-1">
              <Eye className="h-3 w-3" /> Reviewed
            </Badge>
          )}
          {latestSignal && latestSignalLabel && (
            <Badge
              variant={latestSignal.state === 'recent' ? 'outline' : 'destructive'}
              className={latestSignalBadgeClassName}
            >
              <AlertTriangle className="h-3 w-3" />
              {latestSignalLabel}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground">{headerDescription}</p>
        {scope === 'event' && event?.tags.length ? (
          <div className="flex gap-1.5 flex-wrap">
            {event.tags.map(tag => (
              <Badge key={tag.id} variant="secondary" className="gap-1 text-xs">
                <Tag className="h-3 w-3" /> {tag.name}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      <Separator />

      {scope === 'event' && scopeId && (
        <EventPhotosSection slug={slug!} eventId={scopeId} />
      )}

      <Tabs value={activeTab} onValueChange={value => setActiveTab(value as 'volume' | 'distribution' | 'heatmap' | 'breakdowns')}>
        <TabsList>
          <TabsTrigger value="volume">Volume</TabsTrigger>
          <TabsTrigger value="heatmap">Heatmap</TabsTrigger>
          <TabsTrigger value="distribution">
            <GitCompareArrows className="h-3.5 w-3.5" />
            Distribution
          </TabsTrigger>
          {scope === 'event' && (
            <TabsTrigger value="breakdowns">
              <Layers className="h-3.5 w-3.5" />
              Breakdowns
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="volume" className="space-y-6">
          {latestSignal && (
            <Card>
              <CardContent className="grid gap-3 p-4 md:grid-cols-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Bucket</p>
                  <p className="text-sm font-medium">{new Date(latestSignal.bucket).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Actual</p>
                  <p className="text-sm font-medium">{latestSignal.actual_count.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Expected</p>
                  <p className="text-sm font-medium">{Math.round(latestSignal.expected_count).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Z-Score</p>
                  <p className="text-sm font-medium">{latestSignal.z_score.toFixed(2)}</p>
                </div>
              </CardContent>
            </Card>
          )}

          {latestSignal && slug && (
            <TopMoversPanel
              slug={slug}
              scanConfigId={latestSignal.scan_config_id}
              scopeType={latestSignal.scope_type}
              scopeRef={latestSignal.scope_ref}
              bucket={latestSignal.bucket}
              from={timeRange.from}
              to={timeRange.to}
            />
          )}

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">Volume</h2>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex gap-1">
                    {RANGE_OPTIONS.map(option => (
                      <Button
                        key={option.days}
                        variant={rangeDays === option.days ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setRangeDays(option.days)}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                  <Select
                    value={granularity}
                    onValueChange={(value: MetricsGranularity) => setGranularity(value)}
                  >
                    <SelectTrigger className="h-8 w-[130px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GRANULARITY_OPTIONS.map(option => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {metricsQuery.isLoading ? (
                <div className="h-[280px] flex items-center justify-center text-sm text-muted-foreground">
                  Loading monitoring data…
                </div>
              ) : (
                <MetricsChart
                  data={chartData}
                  forecast={metrics?.forecast}
                  annotations={annotations}
                  height={280}
                  color={eventType?.color || 'var(--chart-3)'}
                  granularity={granularity}
                  seriesLabel="events"
                />
              )}
              {metrics?.interval && (
                <p className="text-xs text-muted-foreground mt-2">
                  Collection interval: {metrics.interval}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center gap-2">
                <CalendarPlus className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold">Annotations</h2>
                <span className="text-xs text-muted-foreground">
                  ({annotations.length})
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Mark deploys, releases, or incidents so the chart shows what
                changed when. Snaps to the closest bucket of the current
                scope.
              </p>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={event => {
                  event.preventDefault()
                  if (!annotationBucket || !annotationLabel.trim()) return
                  createAnnotationMut.mutate()
                }}
              >
                <Input
                  type="datetime-local"
                  value={annotationBucket}
                  onChange={event => setAnnotationBucket(event.target.value)}
                  className="h-8 w-[200px]"
                />
                <Input
                  placeholder="Label (e.g. v1.4 deploy)"
                  value={annotationLabel}
                  onChange={event => setAnnotationLabel(event.target.value)}
                  className="h-8 w-[280px]"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={
                    !annotationBucket
                    || !annotationLabel.trim()
                    || createAnnotationMut.isPending
                  }
                >
                  Add
                </Button>
              </form>
              {annotations.length > 0 && (
                <ul className="divide-y divide-border text-xs">
                  {annotations.map(annotation => (
                    <li
                      key={annotation.id}
                      className="flex items-center justify-between gap-2 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: annotation.color }}
                        />
                        <span className="text-muted-foreground">
                          {new Date(annotation.bucket).toLocaleString()}
                        </span>
                        <span className="font-medium">{annotation.label}</span>
                        {annotation.scope_type === null && (
                          <Badge variant="outline" className="text-[10px]">project-wide</Badge>
                        )}
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteAnnotationMut.mutate(annotation.id)}
                        disabled={deleteAnnotationMut.isPending}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="heatmap">
          {metrics?.scan_config_id ? (
            <SeasonalityHeatmap
              slug={slug!}
              scanConfigId={metrics.scan_config_id}
              scopeType={scope}
              scopeRef={scopeId}
              from={timeRange.from}
              to={timeRange.to}
              color={eventType?.color || 'var(--chart-3)'}
            />
          ) : (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">
                No scan config found for this scope yet — run a scan to populate
                the heatmap.
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="distribution">
          <DistributionDriftPanel
            data={distributionQuery.data?.data ?? []}
            fields={distributionQuery.data?.fields ?? []}
            isLoading={distributionQuery.isLoading}
            selectedField={distributionField}
            onSelectedFieldChange={setDistributionField}
          />
        </TabsContent>

        <TabsContent value="breakdowns">
          <Card>
            <CardContent className="p-6">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-lg font-semibold">Breakdowns</h2>
                </div>
                <Select
                  value={selectedBreakdownColumn}
                  onValueChange={value => setBreakdownColumn(value)}
                  disabled={!breakdowns?.columns.length}
                >
                  <SelectTrigger className="h-8 w-[200px]">
                    <SelectValue placeholder="Column" />
                  </SelectTrigger>
                  <SelectContent>
                    {breakdowns?.columns.map(column => (
                      <SelectItem key={column} value={column}>
                        {column}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {breakdownQuery.isLoading ? (
                <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
                  Loading breakdowns…
                </div>
              ) : !breakdowns?.columns.length ? (
                <div className="flex h-[280px] flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
                  <p>No breakdown groups yet.</p>
                  <p className="text-xs">
                    Edit this event and add a column under “Metric breakdowns”, then run a
                    scan — its volume will split into a series per value of that column.
                  </p>
                </div>
              ) : (
                <>
                  <MetricsMultiSeriesChart
                    series={breakdownChartSeries}
                    height={280}
                    granularity={granularity}
                  />
                  {breakdowns?.interval && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Collection interval: {breakdowns.interval}
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {scope === 'event' && event && (
        <>
          {event.field_values.length > 0 && (
            <Card>
              <CardContent className="p-6">
                <h2 className="text-lg font-semibold mb-4">Field Values</h2>
                <div className="grid gap-3">
                  {event.field_values.map(fieldValue => {
                    const fieldDefinition = fieldDefMap.get(fieldValue.field_definition_id)
                    return (
                      <div key={fieldValue.id} className="flex gap-4 text-sm">
                        <span className="text-muted-foreground min-w-[140px] font-medium">
                          {fieldDefinition?.display_name ?? fieldDefinition?.name ?? 'Unknown'}
                        </span>
                        <span className="flex min-w-0 items-center gap-1.5 font-mono text-foreground/80">
                          <span className="break-all">{fieldValue.value || '—'}</span>
                          <VariableValueContextTrigger contexts={fieldValue.variable_values} />
                        </span>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {event.meta_values.length > 0 && (
            <Card>
              <CardContent className="p-6">
                <h2 className="text-lg font-semibold mb-4">Meta Fields</h2>
                <div className="grid gap-3">
                  {event.meta_values.map(metaValue => {
                    const metaField = metaFieldMap.get(metaValue.meta_field_definition_id)
                    const href = metaField ? resolveMetaFieldHref(metaField, metaValue.value) : null
                    return (
                      <div key={metaValue.id} className="flex gap-4 text-sm">
                        <span className="text-muted-foreground min-w-[140px] font-medium">
                          {metaField?.display_name ?? metaField?.name ?? 'Unknown'}
                        </span>
                        <span className="font-mono text-foreground/80 break-all">
                          {href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary underline"
                            >
                              {metaValue.value}
                            </a>
                          ) : metaField?.field_type === 'boolean' ? (
                            metaValue.value === 'true' ? '✓' : '✗'
                          ) : (
                            metaValue.value || '—'
                          )}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function driftBandClassName(band: DistributionDriftBand) {
  if (band === 'significant') return 'border-destructive/60 bg-destructive/10 text-destructive'
  if (band === 'minor') return 'border-amber-500/60 bg-amber-400/15 text-amber-800'
  return 'border-emerald-500/50 bg-emerald-400/10 text-emerald-800'
}

function DistributionShareBar({
  label,
  baselineShare,
  currentShare,
}: {
  label: string
  baselineShare: number
  currentShare: number
}) {
  return (
    <div className="grid gap-2 rounded-md border bg-background p-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="min-w-0 truncate font-mono">{label}</span>
        <span className="shrink-0 text-muted-foreground">
          {formatPercent(baselineShare)} {'->'} {formatPercent(currentShare)}
        </span>
      </div>
      <div className="grid gap-1.5">
        <div className="h-2 rounded-full bg-muted">
          <div
            className="h-2 rounded-full bg-muted-foreground"
            style={{ width: `${Math.max(2, baselineShare * 100)}%` }}
          />
        </div>
        <div className="h-2 rounded-full bg-muted">
          <div
            className="h-2 rounded-full bg-primary"
            style={{ width: `${Math.max(2, currentShare * 100)}%` }}
          />
        </div>
      </div>
    </div>
  )
}

function DistributionDriftPanel({
  data,
  fields,
  isLoading,
  selectedField,
  onSelectedFieldChange,
}: {
  data: DistributionDriftPoint[]
  fields: string[]
  isLoading: boolean
  selectedField: string
  onSelectedFieldChange: (field: string) => void
}) {
  const activeField = fields.includes(selectedField) ? selectedField : fields[0] ?? ''
  const rows = data
    .filter(row => !activeField || row.field_name === activeField)
    .sort((left, right) => left.bucket.localeCompare(right.bucket))
  const latest = rows.at(-1)
  const tableRows = [...rows].reverse().slice(0, 12)

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex h-56 items-center justify-center text-sm text-muted-foreground">
          Loading distribution data…
        </CardContent>
      </Card>
    )
  }

  if (!data.length || !fields.length) {
    return (
      <Card>
        <CardContent className="flex h-56 items-center justify-center text-sm text-muted-foreground">
          No distribution drift data available
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Distribution</h2>
            <Select value={activeField} onValueChange={onSelectedFieldChange}>
              <SelectTrigger className="h-8 w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {fields.map(field => (
                  <SelectItem key={field} value={field}>
                    {field}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {latest && (
            <div className="grid gap-3 md:grid-cols-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Bucket</p>
                <p className="text-sm font-medium">{new Date(latest.bucket).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">PSI</p>
                <p className="text-sm font-medium">{latest.psi.toFixed(3)}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Band</p>
                <Badge variant="outline" className={driftBandClassName(latest.band)}>
                  {latest.band}
                </Badge>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Rows</p>
                <p className="text-sm font-medium">
                  {latest.baseline_total.toLocaleString()} {'->'} {latest.current_total.toLocaleString()}
                </p>
              </div>
            </div>
          )}

          {latest && latest.top_movers.length > 0 && (
            <div className="grid gap-3 md:grid-cols-2">
              {latest.top_movers.slice(0, 6).map(mover => (
                <DistributionShareBar
                  key={mover.value}
                  label={mover.value}
                  baselineShare={mover.baseline_share}
                  currentShare={mover.current_share}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Bucket</th>
                  <th className="px-4 py-3 font-medium">PSI</th>
                  <th className="px-4 py-3 font-medium">Band</th>
                  <th className="px-4 py-3 font-medium">Top contribution</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map(row => {
                  const topMover = row.top_movers[0]
                  return (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(row.bucket).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 font-medium">{row.psi.toFixed(3)}</td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={driftBandClassName(row.band)}>
                          {row.band}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        {topMover ? (
                          <span className="font-mono text-xs">
                            {topMover.value}: {formatPercent(topMover.baseline_share)} {'->'} {formatPercent(topMover.current_share)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
