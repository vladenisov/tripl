import { useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { eventsApi } from '@/api/events'
import { metricsApi } from '@/api/metrics'
import { eventTypesApi } from '@/api/eventTypes'
import { metaFieldsApi } from '@/api/metaFields'
import type { EventType, FieldDefinition, MetaFieldDefinition } from '@/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { ErrorState } from '@/components/error-state'
import EventPhotosSection from '@/components/event-photos-section'
import { VariableValueContextTrigger } from '@/components/variable-value-contexts'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { MetricsChart, MetricsMultiSeriesChart } from '@/components/ui/chart'
import { resolveMetaFieldHref } from '@/lib/metaFields'
import { aggregateMetricPoints, type MetricsGranularity } from '@/lib/metrics'
import { ArrowLeft, CircleCheck, Eye, Layers, Tag } from 'lucide-react'

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

export default function EventDetailPage() {
  const { slug, eventId } = useParams<{ slug: string; eventId: string }>()
  const navigate = useNavigate()
  const [rangeDays, setRangeDays] = useState(30)
  const [granularity, setGranularity] = useState<MetricsGranularity>('hour')
  const [breakdownColumn, setBreakdownColumn] = useState('')

  const eventQuery = useQuery({
    queryKey: ['event', slug, eventId],
    queryFn: () => eventsApi.get(slug!, eventId!),
    enabled: !!slug && !!eventId,
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
    enabled: !!slug,
  })
  const metaFields = metaFieldsQuery.data ?? []

  const timeRange = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - rangeDays * 24 * 60 * 60 * 1000)
    return { from: from.toISOString(), to: to.toISOString() }
  }, [rangeDays])

  const metricsQuery = useQuery({
    queryKey: ['eventMetrics', slug, eventId, rangeDays],
    queryFn: () => metricsApi.getEventMetrics(slug!, eventId!, timeRange),
    enabled: !!slug && !!eventId,
    refetchInterval: 60000,
  })
  const metrics = metricsQuery.data
  const chartData = useMemo(
    () => aggregateMetricPoints(metrics?.data ?? [], granularity),
    [granularity, metrics?.data],
  )

  const breakdownQuery = useQuery({
    queryKey: ['eventMetricBreakdowns', slug, eventId, breakdownColumn, rangeDays],
    queryFn: () => metricsApi.getEventMetricBreakdowns(slug!, eventId!, {
      column: breakdownColumn || undefined,
      ...timeRange,
    }),
    enabled: !!slug && !!eventId,
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

  if (eventQuery.isLoading) {
    return <div className="p-6 text-muted-foreground">Loading…</div>
  }

  if (eventQuery.isError || eventTypesQuery.isError || metaFieldsQuery.isError || metricsQuery.isError || breakdownQuery.isError) {
    return (
      <div className="p-6">
        <ErrorState
          title="Failed to load event details"
          description="The detail page could not fetch data from the backend."
          error={eventQuery.error ?? eventTypesQuery.error ?? metaFieldsQuery.error ?? metricsQuery.error ?? breakdownQuery.error}
          onRetry={() => {
            void Promise.all([
              eventQuery.refetch(),
              eventTypesQuery.refetch(),
              metaFieldsQuery.refetch(),
              metricsQuery.refetch(),
              breakdownQuery.refetch(),
            ])
          }}
        />
      </div>
    )
  }

  if (!event) {
    return <div className="p-6 text-muted-foreground">Event not found</div>
  }

  const eventType = eventTypes.find((et: EventType) => et.id === event.event_type_id)
  const fieldDefs = eventType?.field_definitions ?? []
  const fieldDefMap = new Map(fieldDefs.map((fd: FieldDefinition) => [fd.id, fd]))
  const metaFieldMap = new Map(metaFields.map((mf: MetaFieldDefinition) => [mf.id, mf]))

  return (
    <div className="space-y-6 p-6 max-w-5xl mx-auto">
      {/* Back button */}
      <Button variant="ghost" size="sm" onClick={() => navigate(`/p/${slug}/events`)}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to events
      </Button>

      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold">{event.name}</h1>
          {eventType && (
            <Badge style={{ backgroundColor: eventType.color, color: '#fff' }}>
              {eventType.display_name}
            </Badge>
          )}
          {event.implemented && (
            <Badge variant="outline" className="gap-1">
              <CircleCheck className="h-3 w-3" /> Implemented
            </Badge>
          )}
          {event.reviewed && (
            <Badge variant="outline" className="gap-1">
              <Eye className="h-3 w-3" /> Reviewed
            </Badge>
          )}
          {event.metric_breakdown_columns.length > 0 && (
            <Badge variant="outline" className="gap-1">
              <Layers className="h-3 w-3" /> Breakdowns {event.metric_breakdown_columns.length}
            </Badge>
          )}
        </div>
        {event.description && (
          <p className="text-muted-foreground">{event.description}</p>
        )}
        {event.tags.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            {event.tags.map(t => (
              <Badge key={t.id} variant="secondary" className="gap-1 text-xs">
                <Tag className="h-3 w-3" /> {t.name}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <Separator />

      <EventPhotosSection slug={slug!} eventId={eventId!} />

      {/* Metrics Chart — Event Level */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Event Volume</h2>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex gap-1">
                {RANGE_OPTIONS.map(opt => (
                  <Button
                    key={opt.days}
                    variant={rangeDays === opt.days ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setRangeDays(opt.days)}
                  >
                    {opt.label}
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
          <MetricsChart
            data={chartData}
            forecast={metrics?.forecast}
            height={280}
            color={eventType?.color || undefined}
            granularity={granularity}
          />
          {metrics?.interval && (
            <p className="text-xs text-muted-foreground mt-2">
              Collection interval: {metrics.interval}
            </p>
          )}
        </CardContent>
      </Card>

      {(breakdowns?.columns.length || breakdownQuery.isLoading) && (
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
                <SelectTrigger className="h-8 w-[180px]">
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
      )}

      {/* Field Values */}
      {event.field_values.length > 0 && (
        <Card>
          <CardContent className="p-6">
            <h2 className="text-lg font-semibold mb-4">Field Values</h2>
            <div className="grid gap-3">
              {event.field_values.map(fv => {
                const fd = fieldDefMap.get(fv.field_definition_id)
                const lowCardinalityContexts = (fv.variable_values ?? []).filter(
                  context => context.value_kind === 'low' && context.values.length > 0,
                )
                return (
                  <div key={fv.id} className="flex gap-4 text-sm">
                    <span className="text-muted-foreground min-w-[140px] font-medium">
                      {fd?.display_name ?? fd?.name ?? 'Unknown'}
                    </span>
                    <div className="min-w-0">
                      <span className="flex min-w-0 items-center gap-1.5 font-mono text-foreground/80">
                        <span className="break-all">{fv.value || '—'}</span>
                        <VariableValueContextTrigger contexts={fv.variable_values} />
                      </span>
                      {lowCardinalityContexts.length > 0 && (
                        <div className="mt-1.5 space-y-1 text-xs">
                          {lowCardinalityContexts.map((context) => (
                            <div key={context.id} className="space-y-1">
                              <div className="text-muted-foreground">
                                {`\${${context.variable_name}}`} possible values
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {context.values.map((value) => (
                                  <span
                                    key={`${context.id}-${value}`}
                                    className="max-w-40 truncate rounded border bg-background px-1.5 py-0.5 font-mono text-[10px]"
                                    title={value}
                                  >
                                    {value}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Meta Values */}
      {event.meta_values.length > 0 && (
        <Card>
          <CardContent className="p-6">
            <h2 className="text-lg font-semibold mb-4">Meta Fields</h2>
            <div className="grid gap-3">
              {event.meta_values.map(mv => {
                const mf = metaFieldMap.get(mv.meta_field_definition_id)
                const href = mf ? resolveMetaFieldHref(mf, mv.value) : null
                return (
                  <div key={mv.id} className="flex gap-4 text-sm">
                    <span className="text-muted-foreground min-w-[140px] font-medium">
                      {mf?.display_name ?? mf?.name ?? 'Unknown'}
                    </span>
                    <span className="font-mono text-foreground/80 break-all">
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">{mv.value}</a>
                      ) : mf?.field_type === 'boolean' ? (
                        mv.value === 'true' ? '✓' : '✗'
                      ) : (
                        mv.value || '—'
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
