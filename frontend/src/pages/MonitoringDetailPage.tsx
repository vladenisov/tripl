import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { chartAnnotationsApi } from '@/api/chartAnnotations'
import { eventTypesApi } from '@/api/eventTypes'
import { eventsApi } from '@/api/events'
import { metaFieldsApi } from '@/api/metaFields'
import { metricsApi } from '@/api/metrics'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { scansApi } from '@/api/scans'
import { EVENT_STATUS_LABELS, EVENT_STATUS_TONE } from '@/lib/eventStatus'
import type { EventStatus } from '@/lib/eventStatus'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { Sparkline } from '@/components/primitives/sparkline'
import { SensitivityChip } from '@/components/primitives/sensitivity-chip'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import EventPhotosSection from '@/components/event-photos-section'
import { MetricDefinitionCard } from '@/components/monitoring/metric-definition-card'
import { ReleaseRegressionPanel } from '@/components/monitoring/release-regression-panel'
import { SeasonalityHeatmap } from '@/components/monitoring/seasonality-heatmap'
import { TopMoversPanel } from '@/components/monitoring/top-movers-panel'
import { VariableValueContextTrigger } from '@/components/variable-value-contexts'
import { MetricsChart, MetricsMultiSeriesChart } from '@/components/ui/chart-lazy'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useActiveBranchId } from '@/hooks/useBranch'
import { formatRelativeTime, formatTimestamp } from '@/lib/datetime'
import { formatMetricValue, isPercentUnit, metricAxisFormatter } from '@/lib/metricFormat'
import { GRANULARITY_OPTIONS, RANGE_OPTIONS, aggregateMetricPoints, type MetricsGranularity } from '@/lib/metrics'
import { resolveMetaFieldHref } from '@/lib/metaFields'
import { resolveDetailScope } from '@/lib/monitoring'
import type {
  AppVersionSeriesResponse,
  DistributionDriftBand,
  DistributionDriftPoint,
  Event as TEvent,
  EventMetricBreakdownsResponse,
  EventMetricPoint,
  EventMetricsResponse,
  EventType,
  FieldDefinition,
  MetaFieldDefinition,
  MetricBreakdownsResponse,
  MetricSeriesPoint,
  MetricSeriesResponse,
  MetricSignalResponse,
  MetricVersionSeriesResponse,
  MonitoringSignal,
  AppVersionMetricSeries,
} from '@/types'
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, CalendarPlus, ChevronDown, ChevronLeft, ChevronUp,
  Code, Eye, GitBranch, GitCompareArrows, Layers, Loader2, MoreHorizontal, Pencil, RefreshCw,
  Trash2, TrendingUp,
} from 'lucide-react'
import { toast } from 'sonner'
import { useConfirm } from '@/hooks/useConfirm'

// Stable empty reference so `metaFieldsQuery.data ?? EMPTY_META_FIELDS`
// doesn't mint a new array each render and bust the memoized lookup map.
const EMPTY_META_FIELDS: MetaFieldDefinition[] = []

type MonitoringDetailTab = 'volume' | 'versions' | 'distribution' | 'heatmap' | 'breakdowns'
type VersionFilter = 'all' | 'latest'

const VERSION_CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  '#0f766e',
  '#b45309',
  '#be123c',
]

interface VersionChartSeries {
  label: string
  version: string
  isOther: boolean
  isLatest: boolean
  totalCount: number
  data: AppVersionMetricSeries['data']
  color: string
  isHighlighted: boolean
}

// ───────── Catalog-metric adapters ─────────
// Catalog metric series mirror the event-volume shapes almost exactly (the only
// real difference is a float `value` instead of an integer `count`), so the
// `metric` scope reuses every MonitoringDetailPage consumer by mapping its
// catalog responses onto the event-shaped types the tabs already render.
function metricPointToEventPoint(point: MetricSeriesPoint): EventMetricPoint {
  return {
    bucket: point.bucket,
    count: point.value,
    expected_count: point.expected_count ?? null,
    stddev: point.stddev ?? null,
    is_anomaly: point.is_anomaly,
    anomaly_direction: point.anomaly_direction ?? null,
    z_score: point.z_score ?? null,
  }
}

function metricSignalToMonitoringSignal(signal: MetricSignalResponse): MonitoringSignal {
  return {
    scan_config_id: signal.scan_config_id ?? '',
    scope_type: signal.scope_type,
    scope_ref: signal.scope_ref,
    state: signal.state === 'recent' ? 'recent' : 'latest_scan',
    event_id: signal.event_id ?? null,
    event_type_id: signal.event_type_id ?? null,
    bucket: signal.bucket,
    actual_count: signal.actual_count,
    expected_count: signal.expected_count,
    stddev: signal.stddev,
    z_score: signal.z_score,
    direction: signal.direction,
  }
}

function adaptMetricSeries(res: MetricSeriesResponse): EventMetricsResponse {
  return {
    scope: 'event',
    scan_config_id: res.scan_config_id ?? null,
    event_id: null,
    event_type_id: null,
    interval: res.interval ?? null,
    latest_signal: res.latest_signal ? metricSignalToMonitoringSignal(res.latest_signal) : null,
    data: res.data.map(metricPointToEventPoint),
    // Per-metric forecasting renders a dashed tail that trends toward 0, which
    // is misleading for fractional (ratio/avg) catalog metrics. Drop it for the
    // metric scope; event-scope forecasts come from their own endpoint and are
    // left untouched.
    forecast: [],
  }
}

function adaptMetricVersions(res: MetricVersionSeriesResponse): AppVersionSeriesResponse {
  return {
    scan_config_id: res.scan_config_id ?? '',
    scope_type: 'event',
    scope_ref: '',
    event_id: null,
    event_type_id: null,
    app_version_column: res.app_version_column ?? null,
    interval: res.interval ?? null,
    latest_version: res.latest_version ?? null,
    versions: res.versions,
    series: res.series.map(series => ({
      version: series.version,
      is_other: series.is_other,
      is_latest: series.is_latest,
      total_count: series.total_value,
      data: series.data.map(metricPointToEventPoint),
    })),
  }
}

function adaptMetricBreakdowns(res: MetricBreakdownsResponse): EventMetricBreakdownsResponse {
  return {
    event_id: res.metric_id,
    scan_config_id: res.scan_config_id ?? null,
    interval: res.interval ?? null,
    columns: res.columns,
    selected_column: res.selected_column ?? null,
    series: res.series.map(series => ({
      breakdown_value: series.breakdown_value,
      is_other: series.is_other,
      total_count: series.total_value,
      data: series.data.map(metricPointToEventPoint),
    })),
  }
}

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
  // Catalog-metric drilldowns belong to the Metrics surface, so their back
  // affordance returns to the metrics list rather than the events list.
  const goToMetrics = () => navigate(`/p/${slug}/metrics`)
  const [rangeDays, setRangeDays] = useState(30)
  // null = "no manual pick yet": the effective granularity then follows the
  // scope's default (interval-aware for catalog metrics, hourly otherwise).
  const [granularityOverride, setGranularityOverride] = useState<MetricsGranularity | null>(null)
  const [activeTab, setActiveTab] = useState<MonitoringDetailTab>('volume')
  const metricsRef = useRef<HTMLSpanElement>(null)
  const [versionFilter, setVersionFilter] = useState<VersionFilter>('all')
  const [distributionField, setDistributionField] = useState('')
  const [breakdownColumn, setBreakdownColumn] = useState('')

  const branchId = useActiveBranchId()
  // The legacy `/events/detail/:eventId` route carries no `:scope`; default to
  // the event scope when an eventId is present so the page never crashes on an
  // undefined scope (it now redirects to the canonical URL, but stay defensive).
  const scope = resolveDetailScope(scopeParam, eventId)
  const scopeId = id ?? eventId ?? ''
  // Reused by the header Edit button and the metric-scope Breakdowns empty state.
  const metricEditPath = `/p/${slug}/metrics/${scopeId}/edit`
  // Catalog metrics measure values (ratios, averages), not event volumes, so the
  // primary chart/tab reads "Value" for the metric scope and "Volume" elsewhere.
  const volumeLabel = scope === 'metric' ? 'Value' : 'Volume'

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

  const historyQuery = useQuery({
    queryKey: ['eventHistory', slug, branchId, scopeId],
    queryFn: () => eventsApi.history(slug!, scopeId, branchId),
    enabled: scope === 'event' && !!slug && !!scopeId,
  })
  const eventHistory = historyQuery.data ?? []

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
  const metaFields = metaFieldsQuery.data ?? EMPTY_META_FIELDS

  // Catalog metric definition (header / color / version-column) — only the
  // `metric` scope; the other scopes derive their title from event(-type) data.
  const metricDefinitionQuery = useQuery({
    queryKey: ['metricDefinition', slug, scopeId],
    queryFn: () => metricsCatalogApi.get(slug!, scopeId),
    enabled: scope === 'metric' && !!slug && !!scopeId,
  })
  const metricDefinition = metricDefinitionQuery.data

  // Percent-unit catalog metrics store fractions (0.08 for 8 %): render them
  // ×100 everywhere on this page (chart ticks, tooltip, stat card). Every
  // other unit keeps the raw-number rendering it always had, so the formatter
  // is only threaded through for '%' (tripl-nxk2.1).
  const metricUnit = metricDefinition?.unit ?? null
  const metricIsPercent = scope === 'metric' && isPercentUnit(metricUnit)
  const metricValueFormatter = useMemo(
    () => (metricIsPercent ? metricAxisFormatter(metricUnit) : undefined),
    [metricIsPercent, metricUnit],
  )

  const metricsQuery = useQuery({
    queryKey: ['monitoringMetrics', slug, scope, scopeId, rangeDays],
    queryFn: () => {
      if (scope === 'metric') {
        return metricsCatalogApi.getSeries(slug!, scopeId, timeRange).then(adaptMetricSeries)
      }
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
  // Interval-based catalog metrics chart one point per interval, so 'Hours'
  // is a misleading default (tripl-4m86): follow the collection cadence
  // instead. Event(-type) drilldowns keep their hourly default.
  const defaultGranularity: MetricsGranularity =
    scope === 'metric' && metrics?.interval === '1d'
      ? 'day'
      : scope === 'metric' && metrics?.interval === '1w'
        ? 'week'
        : 'hour'
  const granularity = granularityOverride ?? defaultGranularity
  const scanConfigId = metrics?.scan_config_id ?? (scope === 'project_total' ? scopeId : null)

  const scanConfigQuery = useQuery({
    queryKey: ['scanConfig', slug, scanConfigId],
    queryFn: () => scansApi.get(slug!, scanConfigId!),
    enabled: scope !== 'metric' && !!slug && !!scanConfigId,
  })
  // Catalog metrics expose their version column on the definition; the other
  // scopes read it off the resolved scan config.
  const hasVersionColumn = scope === 'metric'
    ? Boolean(metricDefinition?.app_version_column)
    : Boolean(scanConfigQuery.data?.app_version_column)
  const selectedTab: MonitoringDetailTab = activeTab === 'versions' && !hasVersionColumn
    ? 'volume'
    : activeTab

  const appVersionScope = useMemo(() => {
    // The catalog `metric` scope fetches versions from its own endpoint, so it
    // never builds an event app-version scope (and returning early here narrows
    // `scope` to the three event scopes for the typed app-version API below).
    if (scope === 'metric' || !scanConfigId || !scopeId) return null
    return {
      scope_type: scope,
      scope_ref: scope === 'project_total' ? scanConfigId : scopeId,
    }
  }, [scanConfigId, scope, scopeId])

  const appVersionSeriesQuery = useQuery({
    queryKey: [
      'appVersionSeries',
      slug,
      scope,
      scopeId,
      scanConfigId,
      appVersionScope?.scope_type,
      appVersionScope?.scope_ref,
      timeRange.from,
      timeRange.to,
    ],
    queryFn: () => {
      if (scope === 'metric') {
        return metricsCatalogApi.getVersions(slug!, scopeId, timeRange).then(adaptMetricVersions)
      }
      return metricsApi.getAppVersionSeries(slug!, scanConfigId!, {
        scope_type: appVersionScope!.scope_type,
        scope_ref: appVersionScope!.scope_ref,
        ...timeRange,
      })
    },
    enabled: selectedTab === 'versions' && hasVersionColumn && !!slug && !!scopeId
      && (scope === 'metric' || (!!scanConfigId && !!appVersionScope)),
    refetchInterval: 60000,
  })

  const appVersionAdoptionQuery = useQuery({
    queryKey: ['appVersionAdoption', slug, scanConfigId, timeRange.from, timeRange.to],
    queryFn: () => metricsApi.getAppVersionAdoption(slug!, scanConfigId!, timeRange),
    // No catalog adoption endpoint — the metric scope leaves this card empty.
    enabled: scope !== 'metric' && selectedTab === 'versions' && hasVersionColumn && !!slug && !!scanConfigId,
    refetchInterval: 60000,
  })
  const selectedVersionFilter: VersionFilter = versionFilter === 'latest' && !appVersionSeriesQuery.data?.latest_version
    ? 'all'
    : versionFilter

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
    enabled: selectedTab === 'distribution' && !!slug && !!distributionScope,
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
    queryKey: ['eventMetricBreakdowns', slug, scope, scopeId, breakdownColumn, rangeDays],
    queryFn: () => {
      if (scope === 'metric') {
        return metricsCatalogApi
          .getBreakdowns(slug!, scopeId, { column: breakdownColumn || undefined, ...timeRange })
          .then(adaptMetricBreakdowns)
      }
      return metricsApi.getEventMetricBreakdowns(slug!, scopeId, {
        column: breakdownColumn || undefined,
        ...timeRange,
      })
    },
    enabled: (scope === 'event' || scope === 'metric')
      && selectedTab === 'breakdowns' && !!slug && !!scopeId,
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
  const versionChartSeries = useMemo(
    () => buildVersionChartSeries(
      appVersionSeriesQuery.data?.series ?? [],
      granularity,
      selectedVersionFilter,
      appVersionSeriesQuery.data?.latest_version,
    ),
    [
      appVersionSeriesQuery.data?.latest_version,
      appVersionSeriesQuery.data?.series,
      granularity,
      selectedVersionFilter,
    ],
  )
  const adoptionChartSeries = useMemo(
    () => buildVersionChartSeries(
      appVersionAdoptionQuery.data?.series ?? [],
      granularity,
      selectedVersionFilter,
      appVersionAdoptionQuery.data?.latest_version,
    ),
    [
      appVersionAdoptionQuery.data?.latest_version,
      appVersionAdoptionQuery.data?.series,
      granularity,
      selectedVersionFilter,
    ],
  )
  const adoptionTotal = useMemo(
    () => appVersionAdoptionQuery.data?.totals.reduce((sum, point) => sum + point.count, 0) ?? 0,
    [appVersionAdoptionQuery.data?.totals],
  )
  const latestAdoptionTotal = useMemo(
    () => appVersionAdoptionQuery.data?.series
      .find(series => series.is_latest)?.total_count ?? 0,
    [appVersionAdoptionQuery.data?.series],
  )
  const latestAdoptionShare = adoptionTotal > 0 ? latestAdoptionTotal / adoptionTotal : null

  const queryClient = useQueryClient()
  const annotationsKey = useMemo(
    () => ['chartAnnotations', slug, scope, scopeId, timeRange.from, timeRange.to],
    [slug, scope, scopeId, timeRange.from, timeRange.to],
  )
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
  // Manual "collect now": backfill a recent window for this metric so its chart
  // populates without waiting for the scheduler. Collection runs in the worker,
  // so refetch the series a few seconds after the trigger (the 60s
  // refetchInterval is the backstop).
  const collectMut = useMutation({
    mutationFn: () => metricsCatalogApi.collect(slug!, scopeId),
    onSuccess: () => {
      toast.success('Collection queued — the chart will update shortly.')
      window.setTimeout(() => {
        void queryClient.invalidateQueries({
          queryKey: ['monitoringMetrics', slug, scope, scopeId],
        })
      }, 5000)
    },
    onError: () => toast.error('Could not start collection.'),
  })

  const { confirm: confirmDelete, dialog: deleteDialog } = useConfirm()
  const deleteMetric = async (): Promise<void> => {
    const ok = await confirmDelete({
      title: 'Delete metric?',
      message: `"${metricDefinition?.display_name ?? 'This metric'}" and its collected series will be permanently removed. This can't be undone.`,
      variant: 'danger',
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await metricsCatalogApi.del(slug!, scopeId)
      toast.success('Metric deleted.')
      void queryClient.invalidateQueries({ queryKey: ['metrics-catalog', slug] })
      navigate(`/p/${slug}/metrics`)
    } catch {
      toast.error('Could not delete metric.')
    }
  }

  const eventType = eventTypes.find((candidate: EventType) => (
    scope === 'event'
      ? candidate.id === event?.event_type_id
      : scope === 'event_type' && candidate.id === scopeId
  ))
  const fieldDefMap = useMemo(
    () => new Map(
      (eventType?.field_definitions ?? []).map((field: FieldDefinition) => [field.id, field]),
    ),
    [eventType?.field_definitions],
  )
  const metaFieldMap = useMemo(
    () => new Map(
      metaFields.map((metaField: MetaFieldDefinition) => [metaField.id, metaField]),
    ),
    [metaFields],
  )

  const headerTitle = (() => {
    if (scope === 'metric') return metricDefinition?.display_name ?? 'Metric'
    if (scope === 'project_total') return 'Project Total'
    if (scope === 'event_type') return eventType?.display_name ?? 'Event Type'
    return event?.name ?? 'Event'
  })()
  const headerDescription = (() => {
    if (scope === 'metric') return metricDefinition?.description || 'Catalog metric monitoring detail.'
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
    || metricDefinitionQuery.isError
    || metricsQuery.isError
    || scanConfigQuery.isError
    || appVersionSeriesQuery.isError
    || appVersionAdoptionQuery.isError
    || distributionQuery.isError
  ) {
    return (
      <div className="p-6">
        <ErrorState
          title="Failed to load monitoring details"
          description="The monitoring page could not fetch data from the backend."
          error={
            eventQuery.error
            ?? eventTypesQuery.error
            ?? metaFieldsQuery.error
            ?? metricDefinitionQuery.error
            ?? metricsQuery.error
            ?? scanConfigQuery.error
            ?? appVersionSeriesQuery.error
            ?? appVersionAdoptionQuery.error
            ?? distributionQuery.error
          }
          onRetry={() => {
            const refetches: Promise<unknown>[] = [
              eventTypesQuery.refetch(),
              metricsQuery.refetch(),
            ]
            if (scanConfigId) {
              refetches.push(scanConfigQuery.refetch())
            }
            if (selectedTab === 'versions' && hasVersionColumn) {
              refetches.push(appVersionSeriesQuery.refetch(), appVersionAdoptionQuery.refetch())
            }
            if (selectedTab === 'distribution') {
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

  const isEventDetail = scope === 'event' && !!event

  return (
    <div className={isEventDetail ? 'mx-auto max-w-[1000px] space-y-5 px-4 pb-12 pt-4 sm:px-6' : 'space-y-6 p-4 sm:p-6'}>
      {isEventDetail && event ? (
        <EventDetailHero
          event={event}
          eventType={eventType}
          metrics={metrics}
          history={eventHistory}
          fieldDefMap={fieldDefMap}
          metaFieldMap={metaFieldMap}
          onBack={goBack}
          onEdit={() => navigate(
            `/p/${slug}/events/${event.event_type?.name ?? 'all'}/${event.id}/edit`,
          )}
          onMetrics={() => metricsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={scope === 'metric' ? goToMetrics : goBack}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {scope === 'metric' ? 'Back to metrics' : 'Back to events'}
            </Button>
            {scope === 'metric' && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(metricEditPath)}
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => collectMut.mutate()}
                  disabled={collectMut.isPending}
                  title="Backfill a recent window now so the chart populates without waiting for the scheduler."
                >
                  {collectMut.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  {collectMut.isPending ? 'Collecting…' : 'Collect now'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={deleteMetric}
                  className="text-[var(--danger)] hover:text-[var(--danger)]"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </Button>
                {deleteDialog}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-[22px] font-semibold tracking-[-0.01em]">{headerTitle}</h1>
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
          </div>

          <Separator />
        </>
      )}

      {/* What this catalog metric computes, visible without opening Edit. */}
      {scope === 'metric' && slug && metricDefinition && (
        <MetricDefinitionCard slug={slug} definition={metricDefinition} />
      )}

      {isEventDetail && <span ref={metricsRef} aria-hidden className="-mt-5 block scroll-mt-4" />}
      <Tabs value={selectedTab} onValueChange={value => setActiveTab(value as MonitoringDetailTab)}>
        <TabsList className="text-fg-muted">
          <TabsTrigger value="volume">{volumeLabel}</TabsTrigger>
          {hasVersionColumn && (
            <TabsTrigger value="versions">
              <GitBranch className="h-3.5 w-3.5" />
              By version
            </TabsTrigger>
          )}
          {scope !== 'metric' && <TabsTrigger value="heatmap">Heatmap</TabsTrigger>}
          {scope !== 'metric' && (
            <TabsTrigger value="distribution">
              <GitCompareArrows className="h-3.5 w-3.5" />
              Distribution
            </TabsTrigger>
          )}
          {(scope === 'event' || scope === 'metric') && (
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
                  <p className="text-sm font-medium">{formatTimestamp(latestSignal.bucket)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Actual</p>
                  <p className="text-sm font-medium">
                    {metricIsPercent
                      ? formatMetricValue(latestSignal.actual_count, metricUnit)
                      : latestSignal.actual_count.toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Expected</p>
                  <p className="text-sm font-medium">
                    {metricIsPercent
                      ? formatMetricValue(latestSignal.expected_count, metricUnit)
                      : Math.round(latestSignal.expected_count).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Z-Score</p>
                  <p className="text-sm font-medium">{latestSignal.z_score.toFixed(2)}</p>
                </div>
              </CardContent>
            </Card>
          )}

          {latestSignal && slug && scope !== 'metric' && (
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
                <h2 className="text-lg font-semibold">{volumeLabel}</h2>
                <MetricsRangeControls
                  rangeDays={rangeDays}
                  granularity={granularity}
                  onRangeDaysChange={setRangeDays}
                  onGranularityChange={setGranularityOverride}
                />
              </div>
              {metricsQuery.isLoading ? (
                <div className="h-[280px] flex items-center justify-center text-sm text-muted-foreground">
                  Loading monitoring data…
                </div>
              ) : chartData.length === 0 ? (
                <div className="h-[280px] flex items-center justify-center">
                  <EmptyState
                    icon={TrendingUp}
                    title="No metrics data available"
                    description="Run a scan to start collecting volume metrics for this scope."
                  />
                </div>
              ) : (
                <MetricsChart
                  data={chartData}
                  forecast={metrics?.forecast}
                  annotations={annotations}
                  height={280}
                  color={eventType?.color || metricDefinition?.color || 'var(--chart-3)'}
                  granularity={granularity}
                  seriesLabel={scope === 'metric' ? metricDefinition?.unit || 'value' : 'events'}
                  valueFormatter={metricValueFormatter}
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
                <Label htmlFor="annotation-bucket" className="sr-only">Date and time</Label>
                <Input
                  id="annotation-bucket"
                  type="datetime-local"
                  value={annotationBucket}
                  onChange={event => setAnnotationBucket(event.target.value)}
                  className="h-8 w-[200px]"
                />
                <Label htmlFor="annotation-label" className="sr-only">Label</Label>
                <Input
                  id="annotation-label"
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
              {createAnnotationMut.isError && (
                <p role="alert" className="text-xs text-destructive">
                  {createAnnotationMut.error instanceof Error
                    ? createAnnotationMut.error.message
                    : 'Failed to add annotation.'}
                </p>
              )}
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
                          {formatTimestamp(annotation.bucket)}
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
                        aria-label={`Delete annotation ${annotation.label}`}
                      >
                        <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {hasVersionColumn && (
          <TabsContent value="versions" className="space-y-4">
            <Card>
              <CardContent className="p-6">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-lg font-semibold">By version</h2>
                    {appVersionSeriesQuery.data?.latest_version && (
                      <Badge variant="outline" className="font-mono">
                        latest {appVersionSeriesQuery.data.latest_version}
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex h-8 items-center rounded-md border bg-muted/30 p-0.5">
                      <Button
                        type="button"
                        size="sm"
                        variant={selectedVersionFilter === 'all' ? 'secondary' : 'ghost'}
                        className="h-6 px-2 text-xs"
                        onClick={() => setVersionFilter('all')}
                      >
                        All versions
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={selectedVersionFilter === 'latest' ? 'secondary' : 'ghost'}
                        className="h-6 px-2 text-xs"
                        onClick={() => setVersionFilter('latest')}
                        disabled={!appVersionSeriesQuery.data?.latest_version}
                      >
                        Latest
                      </Button>
                    </div>
                    <MetricsRangeControls
                      rangeDays={rangeDays}
                      granularity={granularity}
                      onRangeDaysChange={setRangeDays}
                      onGranularityChange={setGranularityOverride}
                    />
                  </div>
                </div>
                {appVersionSeriesQuery.isLoading ? (
                  <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
                    Loading version metrics…
                  </div>
                ) : (
                  <>
                    <MetricsMultiSeriesChart
                      series={versionChartSeries}
                      height={280}
                      granularity={granularity}
                      emptyLabel="No version metrics available"
                    />
                    <VersionLegend series={versionChartSeries} />
                    {appVersionSeriesQuery.data?.interval && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Collection interval: {appVersionSeriesQuery.data.interval}
                      </p>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold">Version adoption</h2>
                    {latestAdoptionShare !== null && (
                      <Badge variant="outline">
                        Latest {formatPercent(latestAdoptionShare)}
                      </Badge>
                    )}
                  </div>
                  {appVersionAdoptionQuery.data?.app_version_column && (
                    <Badge variant="secondary" className="font-mono">
                      {appVersionAdoptionQuery.data.app_version_column}
                    </Badge>
                  )}
                </div>
                {appVersionAdoptionQuery.isLoading ? (
                  <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
                    Loading adoption…
                  </div>
                ) : (
                  <>
                    <MetricsMultiSeriesChart
                      series={adoptionChartSeries}
                      height={240}
                      granularity={granularity}
                      emptyLabel="No adoption data available"
                    />
                    <VersionLegend series={adoptionChartSeries} />
                  </>
                )}
              </CardContent>
            </Card>

            {scope !== 'metric' && scanConfigId && (
              <ReleaseRegressionPanel
                slug={slug!}
                scanConfigId={scanConfigId}
                enabled={selectedTab === 'versions'}
              />
            )}
          </TabsContent>
        )}

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
                  {scope === 'metric' ? (
                    <>
                      <p className="text-xs">
                        Add breakdown columns in the metric settings — each configured
                        column splits this metric into a series per value after the next
                        collection.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={() => navigate(metricEditPath)}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit metric
                      </Button>
                    </>
                  ) : (
                    <p className="text-xs">
                      Edit this event and add a column under “Metric breakdowns”, then run a
                      scan — its volume will split into a series per value of that column.
                    </p>
                  )}
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

      {scope === 'event' && scopeId && (
        <EventPhotosSection slug={slug!} eventId={scopeId} />
      )}
    </div>
  )
}

function MetricsRangeControls({
  rangeDays,
  granularity,
  onRangeDaysChange,
  onGranularityChange,
}: {
  rangeDays: number
  granularity: MetricsGranularity
  onRangeDaysChange: (days: number) => void
  onGranularityChange: (granularity: MetricsGranularity) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex gap-1">
        {RANGE_OPTIONS.map(option => (
          <Button
            key={option.days}
            variant={rangeDays === option.days ? 'default' : 'outline'}
            size="sm"
            onClick={() => onRangeDaysChange(option.days)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      <Select
        value={granularity}
        onValueChange={(value: MetricsGranularity) => onGranularityChange(value)}
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
  )
}

function buildVersionChartSeries(
  series: AppVersionMetricSeries[],
  granularity: MetricsGranularity,
  versionFilter: VersionFilter,
  latestVersion: string | null | undefined,
): VersionChartSeries[] {
  return series
    .filter(item => versionFilter === 'all' || (!!latestVersion && item.is_latest))
    .map((item, index) => {
      const isLatest = item.is_latest && !item.is_other
      return {
        label: formatVersionLabel(item),
        version: item.version,
        isOther: item.is_other,
        isLatest,
        totalCount: item.total_count,
        data: aggregateMetricPoints(item.data, granularity),
        color: isLatest
          ? 'var(--primary)'
          : item.is_other
            ? 'var(--muted-foreground)'
            : VERSION_CHART_COLORS[index % VERSION_CHART_COLORS.length],
        isHighlighted: isLatest,
      }
    })
}

function formatVersionLabel(version: AppVersionMetricSeries) {
  const label = version.is_other ? 'Other' : (version.version || '(empty)')
  return version.is_latest && !version.is_other ? `${label} · latest` : label
}

function VersionLegend({ series }: { series: VersionChartSeries[] }) {
  if (!series.length) return null
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {series.map(item => (
        <div
          key={`${item.version}-${item.isOther}`}
          className="flex min-w-0 items-center gap-2 rounded-md border bg-background px-2 py-1 text-xs"
        >
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: item.color }}
          />
          <span className="min-w-0 truncate font-mono">{item.isOther ? 'Other' : item.version}</span>
          {item.isLatest && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              latest
            </Badge>
          )}
          <span className="shrink-0 text-muted-foreground">
            {item.totalCount.toLocaleString()}
          </span>
        </div>
      ))}
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
                <p className="text-sm font-medium">{formatTimestamp(latest.bucket)}</p>
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
                        {formatTimestamp(row.bucket)}
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

// ───────── Event detail (page-based, mockup EventDetailPage) ─────────

const DAY_MS = 24 * 60 * 60 * 1000
const SURFACE_CARD = 'overflow-hidden rounded-[10px] border'
const SURFACE_STYLE = { background: 'var(--surface)', borderColor: 'var(--border)' } as const
const EV_TH_CLASS = 'px-[14px] py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.04em] text-[var(--fg-subtle)]'
const EV_TD_CLASS = 'px-[14px] py-[9px] text-[12.5px] align-middle'

type EventDetailStats = {
  volume24h: number | null
  delta24h: number | null
  series24h: number[]
}

type EventHistoryItem = { id: string; field: string; created_at: string; new_value: string | null }

/**
 * Derives the event-detail stat strip + trend from the real volume series.
 * The mockup's error-rate/coverage have no API source, so the strip instead
 * surfaces real fields (drift count, last seen) alongside 24h volume + delta.
 */
function computeEventStats(metrics: EventMetricsResponse | undefined): EventDetailStats {
  const points = metrics?.data ?? []
  if (points.length === 0) return { volume24h: null, delta24h: null, series24h: [] }
  const hourly = aggregateMetricPoints(points, 'hour')
  const latest = Date.parse(hourly[hourly.length - 1]?.bucket ?? '') || Date.now()
  const recent = hourly.filter(p => latest - Date.parse(p.bucket) < DAY_MS)
  const prior = hourly.filter(p => {
    const age = latest - Date.parse(p.bucket)
    return age >= DAY_MS && age < 2 * DAY_MS
  })
  const sum = (rows: EventMetricPoint[]) => rows.reduce((total, p) => total + p.count, 0)
  const volume24h = sum(recent)
  const priorVolume = sum(prior)
  const delta24h = priorVolume > 0 ? ((volume24h - priorVolume) / priorVolume) * 100 : null
  return { volume24h, delta24h, series24h: recent.map(p => p.count) }
}

function formatNum(value: number): string {
  return value.toLocaleString()
}

function EventDetailHero({
  event,
  eventType,
  metrics,
  history,
  fieldDefMap,
  metaFieldMap,
  onBack,
  onEdit,
  onMetrics,
}: {
  event: TEvent
  eventType: EventType | undefined
  metrics: EventMetricsResponse | undefined
  history: EventHistoryItem[]
  fieldDefMap: Map<string, FieldDefinition>
  metaFieldMap: Map<string, MetaFieldDefinition>
  onBack: () => void
  onEdit: () => void
  onMetrics: () => void
}) {
  const stats = computeEventStats(metrics)
  const signal = metrics?.latest_signal ?? null
  const signalTone: 'danger' | 'warning' = signal?.direction === 'drop' ? 'warning' : 'danger'
  return (
    <div className="space-y-[18px]">
      <EventDetailBreadcrumb name={event.name} onBack={onBack} />
      <EventDetailHeader event={event} eventType={eventType} signal={signal} onEdit={onEdit} onMetrics={onMetrics} />
      {signal && <EventSignalBanner signal={signal} tone={signalTone} />}
      <EventStatStrip event={event} stats={stats} />
      {stats.series24h.length > 1 && (
        <div className={SURFACE_CARD} style={SURFACE_STYLE}>
          <div className="flex items-center justify-between px-4 py-[14px]">
            <span className="text-[12.5px] font-semibold">Volume · 24h</span>
            <span className="mono text-[11px]" style={{ color: 'var(--fg-subtle)' }}>hourly</span>
          </div>
          <div className="px-4 pb-[14px]">
            <Sparkline
              data={stats.series24h}
              width={920}
              height={64}
              color={signal ? `var(--${signalTone})` : 'var(--accent)'}
              className="w-full"
            />
          </div>
        </div>
      )}
      <div className="grid items-start gap-[14px] lg:grid-cols-[1.5fr_1fr]">
        <EventFieldsTable eventType={eventType} event={event} fieldDefMap={fieldDefMap} />
        <EventSideColumn event={event} eventType={eventType} history={history} metaFieldMap={metaFieldMap} />
      </div>
    </div>
  )
}

function EventDetailBreadcrumb({ name, onBack }: { name: string; onBack: () => void }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[11.5px]">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 transition-colors hover:text-[var(--fg)]"
        style={{ color: 'var(--fg-muted)' }}
      >
        <ChevronLeft size={13} /> Plan
      </button>
      <span aria-hidden style={{ color: 'var(--fg-faint)' }}>/</span>
      <button
        type="button"
        onClick={onBack}
        className="transition-colors hover:text-[var(--fg)]"
        style={{ color: 'var(--fg-muted)' }}
      >
        Events
      </button>
      <span aria-hidden style={{ color: 'var(--fg-faint)' }}>/</span>
      <span aria-current="page" className="mono min-w-0 truncate" style={{ color: 'var(--fg)' }}>
        {name}
      </span>
      <div className="flex-1" />
      <button
        type="button"
        disabled
        title="Coming soon"
        className="inline-flex h-6 items-center gap-1 rounded-[6px] px-2 text-[11px] opacity-40"
        style={{ color: 'var(--fg-muted)' }}
      >
        <ChevronUp size={11} /> Prev
      </button>
      <button
        type="button"
        disabled
        title="Coming soon"
        className="inline-flex h-6 items-center gap-1 rounded-[6px] px-2 text-[11px] opacity-40"
        style={{ color: 'var(--fg-muted)' }}
      >
        <ChevronDown size={11} /> Next
      </button>
    </nav>
  )
}

function HeroAction({
  icon,
  label,
  primary,
  onClick,
  disabled,
  title,
}: {
  icon: ReactNode
  label: string
  primary?: boolean
  onClick?: () => void
  disabled?: boolean
  /** Hover/long-press hint — used to explain why a disabled action is inert. */
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex h-8 items-center gap-[6px] rounded-[7px] border px-[10px] text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        background: primary ? 'var(--accent)' : 'var(--surface)',
        color: primary ? 'var(--accent-fg)' : 'var(--fg)',
        borderColor: primary ? 'var(--accent)' : 'var(--border)',
      }}
    >
      {icon} {label}
    </button>
  )
}

function EventDetailHeader({
  event,
  eventType,
  signal,
  onEdit,
  onMetrics,
}: {
  event: TEvent
  eventType: EventType | undefined
  signal: MonitoringSignal | null
  onEdit: () => void
  onMetrics: () => void
}) {
  const status = event.status as EventStatus
  const statusTone = EVENT_STATUS_TONE[status] ?? 'neutral'
  const typeColor = eventType?.color ?? 'var(--fg-faint)'
  const typeLabel = eventType?.display_name ?? event.event_type?.display_name ?? 'Event'
  return (
    <div className="flex flex-wrap items-start gap-[13px]">
      <span className="mt-[7px] flex-shrink-0">
        {signal
          ? <Dot tone={signal.direction === 'drop' ? 'warning' : 'danger'} pulse size={8} />
          : <Dot tone={statusTone} size={8} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-[10px]">
          <h1 className="mono m-0 text-[19px] font-semibold tracking-[-0.01em]">{event.name}</h1>
          <Chip tone={statusTone} size="sm">{EVENT_STATUS_LABELS[status] ?? event.status}</Chip>
          {event.tags.map(tag => <Chip key={tag.id} size="xs">{tag.name}</Chip>)}
        </div>
        <div className="mt-[7px] flex flex-wrap items-center gap-2 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
          <span className="inline-flex items-center gap-[5px]">
            <span className="h-[7px] w-[7px] rounded-[2px]" style={{ background: typeColor }} />
            {typeLabel}
          </span>
          <span style={{ color: 'var(--fg-faint)' }}>·</span>
          <span>updated {formatRelativeTime(event.updated_at)}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <HeroAction icon={<TrendingUp size={12} />} label="Metrics" onClick={onMetrics} />
        <HeroAction icon={<Pencil size={12} />} label="Edit" primary onClick={onEdit} />
        <EventActionOverflow />
      </div>
    </div>
  )
}

/**
 * Overflow ("…") menu for not-yet-shipped actions. Keeping Watch / Implementation
 * out of the primary row — rather than as inert disabled buttons beside the live
 * ones — stops the dead CTAs from undercutting confidence in the working actions.
 */
function EventActionOverflow() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="More actions"
          className="inline-flex h-8 w-8 items-center justify-center rounded-[7px] border transition-colors hover:bg-[var(--surface-hover)]"
          style={{ background: 'var(--surface)', color: 'var(--fg-muted)', borderColor: 'var(--border)' }}
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-[180px]">
        <DropdownMenuLabel
          className="text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: 'var(--fg-faint)' }}
        >
          Coming soon
        </DropdownMenuLabel>
        <DropdownMenuItem disabled className="text-[12.5px]">
          <Eye className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} /> Watch
        </DropdownMenuItem>
        <DropdownMenuItem disabled className="text-[12.5px]">
          <Code className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} /> Implementation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function EventSignalBanner({ signal, tone }: { signal: MonitoringSignal; tone: 'danger' | 'warning' }) {
  const delta = signal.expected_count > 0
    ? ((signal.actual_count - signal.expected_count) / signal.expected_count) * 100
    : null
  const Arrow = signal.direction === 'drop' ? ArrowDown : ArrowUp
  return (
    <div
      className="flex items-center gap-[10px] rounded-[10px] px-[14px] py-[10px]"
      style={{
        background: `var(--${tone}-soft)`,
        border: `1px solid color-mix(in oklab, var(--${tone}) 35%, var(--border))`,
      }}
    >
      <Arrow size={15} style={{ color: `var(--${tone})` }} />
      <span className="text-[12.5px]" style={{ color: 'var(--fg-muted)' }}>
        {signal.direction === 'drop' ? 'Volume drop' : 'Volume spike'} detected
        {delta != null && ` — ${delta > 0 ? '+' : ''}${delta.toFixed(0)}% vs. baseline`}
        {` (z = ${signal.z_score.toFixed(1)}).`}
      </span>
      <div className="flex-1" />
      <span className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
        {formatTimestamp(signal.bucket)}
      </span>
    </div>
  )
}

function StatCard({
  label,
  value,
  tone,
  hint,
  empty,
}: {
  label: string
  value: string
  tone?: 'danger' | 'warning'
  /** Hover/long-press explanation, e.g. for an empty "—" value. */
  hint?: string
  /** De-emphasise the value when it represents a no-data ("—" / "0") state. */
  empty?: boolean
}) {
  const color = empty
    ? 'var(--fg-faint)'
    : tone === 'danger'
      ? 'var(--danger)'
      : tone === 'warning'
        ? 'var(--warning)'
        : 'var(--fg)'
  return (
    <div className="rounded-[10px] border px-[14px] py-[11px]" style={SURFACE_STYLE} title={hint}>
      <div className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>{label}</div>
      <div className="mono tnum mt-1 text-[19px] font-medium" style={{ color }}>{value}</div>
    </div>
  )
}

function EventStatStrip({ event, stats }: { event: TEvent; stats: EventDetailStats }) {
  const deltaTone: 'danger' | 'warning' | undefined = stats.delta24h == null
    ? undefined
    : stats.delta24h > 20 ? 'danger' : stats.delta24h < -20 ? 'warning' : undefined
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard
        label="Volume · 24h"
        value={stats.volume24h == null ? '—' : formatNum(stats.volume24h)}
        empty={stats.volume24h == null}
        hint={stats.volume24h == null ? 'No events in the last 24h' : undefined}
      />
      <StatCard
        label="Δ · 24h"
        value={stats.delta24h == null ? '—' : `${stats.delta24h > 0 ? '+' : ''}${stats.delta24h.toFixed(0)}%`}
        tone={deltaTone}
        empty={stats.delta24h == null}
        hint={stats.delta24h == null ? 'No prior 24h window to compare against' : undefined}
      />
      <StatCard
        label="Schema drifts"
        value={formatNum(event.drift_count)}
        tone={event.drift_count > 0 ? 'warning' : undefined}
        empty={event.drift_count === 0}
        hint={event.drift_count === 0 ? 'No schema drifts detected' : undefined}
      />
      <StatCard
        label="Last seen"
        value={event.last_seen_at ? formatRelativeTime(event.last_seen_at) : '—'}
        empty={!event.last_seen_at}
        hint={event.last_seen_at ? undefined : 'No hits recorded yet'}
      />
    </div>
  )
}

function EventFieldsTable({
  eventType,
  event,
  fieldDefMap,
}: {
  eventType: EventType | undefined
  event: TEvent
  fieldDefMap: Map<string, FieldDefinition>
}) {
  const fields = [...(eventType?.field_definitions ?? [])].sort((a, b) => a.order - b.order)
  const valueByField = new Map(event.field_values.map(fv => [fv.field_definition_id, fv]))
  const requiredCount = fields.filter(f => f.is_required).length
  // Hide the Sensitivity column when no field carries a sensitivity label —
  // otherwise it renders a "—" for every row, adding noise without signal.
  const showSensitivity = fields.some(f => (fieldDefMap.get(f.id) ?? f).sensitivity !== 'none')
  return (
    <div className={SURFACE_CARD} style={SURFACE_STYLE}>
      <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <span className="flex-1 text-[12.5px] font-semibold">Fields</span>
        <span className="mono text-[10.5px]" style={{ color: 'var(--fg-subtle)' }}>
          {fields.length} · {requiredCount} required
        </span>
      </div>
      {fields.length === 0 ? (
        <div className="px-4 py-7 text-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
          No fields defined.
        </div>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full border-collapse" aria-label="Fields">
          <thead>
            <tr style={{ background: 'var(--bg-sunken)' }}>
              <th scope="col" className={EV_TH_CLASS}>Field</th>
              <th scope="col" className={EV_TH_CLASS}>Type</th>
              <th scope="col" className={EV_TH_CLASS}>Value</th>
              {showSensitivity && <th scope="col" className={EV_TH_CLASS}>Sensitivity</th>}
            </tr>
          </thead>
          <tbody>
            {fields.map(field => {
              const fv = valueByField.get(field.id)
              const def = fieldDefMap.get(field.id) ?? field
              return (
                <tr key={field.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td className={EV_TD_CLASS}>
                    <span className="mono text-[12px]">{def.name}</span>
                    {def.is_required && <span className="ml-[3px]" style={{ color: 'var(--danger)' }}>*</span>}
                  </td>
                  <td className={EV_TD_CLASS}><Chip size="xs" variant="outline">{def.field_type}</Chip></td>
                  <td className={EV_TD_CLASS}>
                    <span className="mono inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
                      <span className="break-all">{fv?.value || '—'}</span>
                      {fv?.variable_values?.length ? (
                        <VariableValueContextTrigger contexts={fv.variable_values} />
                      ) : null}
                    </span>
                  </td>
                  {showSensitivity && (
                    <td className={EV_TD_CLASS}><SensitivityChip value={def.sensitivity} /></td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      )}
    </div>
  )
}

function PropertyRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div role="row" className="flex gap-3 px-4 py-[6px] text-[12px]">
      <span role="rowheader" className="w-[120px] flex-shrink-0" style={{ color: 'var(--fg-subtle)' }}>{label}</span>
      <span role="cell" className={`min-w-0 flex-1 break-words ${mono ? 'mono' : ''}`} style={{ color: 'var(--fg)' }}>
        {value}
      </span>
    </div>
  )
}

function EventMetaCard({
  event,
  metaFieldMap,
}: {
  event: TEvent
  metaFieldMap: Map<string, MetaFieldDefinition>
}) {
  if (event.meta_values.length === 0) return null
  return (
    <div className={SURFACE_CARD} style={SURFACE_STYLE}>
      <div className="border-b px-4 py-3 text-[12.5px] font-semibold" style={{ borderColor: 'var(--border-subtle)' }}>
        Meta fields
      </div>
      <div role="table" aria-label="Meta fields" className="py-[6px]">
        {event.meta_values.map(mv => {
          const def = metaFieldMap.get(mv.meta_field_definition_id)
          const href = def ? resolveMetaFieldHref(def, mv.value) : null
          const display = def?.field_type === 'boolean'
            ? (mv.value === 'true' ? '✓' : '✗')
            : (mv.value || '—')
          return (
            <PropertyRow
              key={mv.id}
              label={def?.display_name ?? def?.name ?? 'Unknown'}
              value={href
                ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent)' }}>{mv.value}</a>
                : display}
              mono
            />
          )
        })}
      </div>
    </div>
  )
}

function EventSideColumn({
  event,
  eventType,
  history,
  metaFieldMap,
}: {
  event: TEvent
  eventType: EventType | undefined
  history: EventHistoryItem[]
  metaFieldMap: Map<string, MetaFieldDefinition>
}) {
  const breakdowns = event.metric_breakdown_columns
  return (
    <div className="flex flex-col gap-[14px]">
      <div className={SURFACE_CARD} style={SURFACE_STYLE}>
        <div className="border-b px-4 py-3 text-[12.5px] font-semibold" style={{ borderColor: 'var(--border-subtle)' }}>
          Properties
        </div>
        <div role="table" aria-label="Properties" className="py-[6px]">
          <PropertyRow label="Event type" value={eventType?.display_name ?? event.event_type?.display_name ?? '—'} />
          <PropertyRow label="Status" value={EVENT_STATUS_LABELS[event.status as EventStatus] ?? event.status} />
          <PropertyRow label="Event ID" value={event.id} mono />
          <PropertyRow label="First seen" value={formatTimestamp(event.created_at)} />
          <PropertyRow label="Updated" value={formatRelativeTime(event.updated_at)} />
          <PropertyRow label="Last seen" value={event.last_seen_at ? formatTimestamp(event.last_seen_at) : '—'} />
          {event.sunset_at && <PropertyRow label="Sunset" value={formatTimestamp(event.sunset_at)} />}
        </div>
      </div>

      <EventMetaCard event={event} metaFieldMap={metaFieldMap} />

      <div className={SURFACE_CARD} style={SURFACE_STYLE}>
        <div className="border-b px-4 py-3 text-[12.5px] font-semibold" style={{ borderColor: 'var(--border-subtle)' }}>
          Metric breakdowns
        </div>
        <div className="flex flex-wrap gap-[6px] px-4 py-[12px]">
          {breakdowns.length > 0
            ? breakdowns.map(column => <Chip key={column} size="xs" variant="outline">{column}</Chip>)
            : <span className="text-[12px]" style={{ color: 'var(--fg-subtle)' }}>No event-level breakdowns</span>}
        </div>
      </div>

      <div className={SURFACE_CARD} style={SURFACE_STYLE}>
        <div className="border-b px-4 py-3 text-[12.5px] font-semibold" style={{ borderColor: 'var(--border-subtle)' }}>
          Recent activity
        </div>
        <div className="py-[4px]">
          {history.length === 0 ? (
            <div className="px-4 py-5 text-center" style={{ color: 'var(--fg-subtle)' }}>
              <p className="text-[11.5px] font-medium" style={{ color: 'var(--fg-muted)' }}>
                No recent changes
              </p>
              <p className="mt-1 text-[10.5px]">
                Edits to this event's definition will show up here.
              </p>
            </div>
          ) : history.slice(0, 4).map(change => (
            <div key={change.id} className="flex gap-[10px] border-t px-4 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
              <Dot tone="neutral" size={6} className="mt-[5px]" />
              <div className="min-w-0 flex-1">
                <div className="text-[11.5px] font-medium">
                  <span className="mono">{change.field}</span>
                  {change.new_value != null && <span style={{ color: 'var(--fg-muted)' }}> → {change.new_value}</span>}
                </div>
                <div className="mt-[2px] text-[10.5px]" style={{ color: 'var(--fg-subtle)' }}>
                  {formatRelativeTime(change.created_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
