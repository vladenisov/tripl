import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { eventTypesApi } from '@/api/eventTypes'
import { eventsApi } from '@/api/events'
import { metaFieldsApi } from '@/api/metaFields'
import { metricsApi } from '@/api/metrics'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ErrorState } from '@/components/error-state'
import EventPhotosSection from '@/components/event-photos-section'
import { TopMoversPanel } from '@/components/monitoring/top-movers-panel'
import { MetricsChart } from '@/components/ui/chart'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { aggregateMetricPoints, type MetricsGranularity } from '@/lib/metrics'
import { resolveMetaFieldHref } from '@/lib/metaFields'
import type { EventType, FieldDefinition, MetaFieldDefinition } from '@/types'
import { AlertTriangle, ArrowLeft, CircleCheck, Eye, Tag } from 'lucide-react'

const RANGE_OPTIONS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
] as const

const GRANULARITY_OPTIONS: { value: MetricsGranularity; label: string }[] = [
  { value: 'hour', label: 'Hours' },
  { value: 'day', label: 'Days' },
  { value: 'week', label: 'Weeks' },
  { value: 'month', label: 'Months' },
]

function routeScopeToApiScope(scope: string | undefined) {
  if (scope === 'project-total') return 'project_total'
  if (scope === 'event-type') return 'event_type'
  return 'event'
}

export default function MonitoringDetailPage() {
  const { slug, scope: scopeParam, id, eventId } = useParams<{
    slug: string
    scope?: string
    id?: string
    eventId?: string
  }>()
  const navigate = useNavigate()
  const [rangeDays, setRangeDays] = useState(30)
  const [granularity, setGranularity] = useState<MetricsGranularity>('hour')

  const scope = routeScopeToApiScope(scopeParam)
  const scopeId = id ?? eventId ?? ''

  const timeRange = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - rangeDays * 24 * 60 * 60 * 1000)
    return { from: from.toISOString(), to: to.toISOString() }
  }, [rangeDays])

  const eventQuery = useQuery({
    queryKey: ['event', slug, scopeId],
    queryFn: () => eventsApi.get(slug!, scopeId),
    enabled: scope === 'event' && !!slug && !!scopeId,
  })
  const event = eventQuery.data

  const eventTypesQuery = useQuery({
    queryKey: ['eventTypes', slug],
    queryFn: () => eventTypesApi.list(slug!),
    enabled: !!slug,
  })
  const eventTypes = eventTypesQuery.data ?? []

  const metaFieldsQuery = useQuery({
    queryKey: ['metaFields', slug],
    queryFn: () => metaFieldsApi.list(slug!),
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

  const chartData = useMemo(
    () => aggregateMetricPoints(metrics?.data ?? [], granularity),
    [granularity, metrics?.data],
  )

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

  if (eventQuery.isError || eventTypesQuery.isError || metaFieldsQuery.isError || metricsQuery.isError) {
    return (
      <div className="p-6">
        <ErrorState
          title="Failed to load monitoring details"
          description="The monitoring page could not fetch data from the backend."
          error={eventQuery.error ?? eventTypesQuery.error ?? metaFieldsQuery.error ?? metricsQuery.error}
          onRetry={() => {
            const refetches: Promise<unknown>[] = [
              eventTypesQuery.refetch(),
              metricsQuery.refetch(),
            ]
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
      <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${slug}/events`)}>
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
                        <span className="font-mono text-foreground/80 break-all">
                          {fieldValue.value || '—'}
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
