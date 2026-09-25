import { useMemo, useRef } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, GitBranch, GitCompareArrows, Layers, TrendingUp } from 'lucide-react'
import { eventTypesApi } from '@/api/eventTypes'
import { eventsApi } from '@/api/events'
import { metaFieldsApi } from '@/api/metaFields'
import { metricsApi } from '@/api/metrics'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { scansApi } from '@/api/scans'
import { EmptyState } from '@/components/empty-state'
import { EntityBranchBanner } from '@/components/EntityBranchBanner'
import { ErrorState } from '@/components/error-state'
import EventPhotosSection from '@/components/event-photos-section'
import { EventValueDriftPanel } from '@/pages/events/EventValueDriftPanel'
import { EventSpecCard } from '@/components/EventSpecCard'
import { MetricDefinitionCard } from '@/components/monitoring/metric-definition-card'
import { SeasonalityHeatmap } from '@/components/monitoring/seasonality-heatmap'
import { TopMoversPanel } from '@/components/monitoring/top-movers-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { MetricsChart } from '@/components/ui/chart-lazy'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useActiveBranchId, useBranchLinkProps } from '@/hooks/useBranch'
import { useLiveTimeRange } from '@/hooks/useLiveTimeRange'
import { formatIncidentCount } from '@/lib/alertStatus'
import { formatTimestamp } from '@/lib/datetime'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import {
  adaptMetricSeries,
  defaultDrilldownGranularity,
  granularityForInterval,
  metricRollupMode,
} from '@/lib/metricAdapters'
import { formatMetricValue, isPercentUnit, metricAxisFormatter } from '@/lib/metricFormat'
import { aggregateMetricPoints, clampGranularityToRange, type MetricsGranularity } from '@/lib/metrics'
import { resolveDetailScope } from '@/lib/monitoring'
import { useCanWriteProject } from '@/lib/permissions'
import {
  eventHistoryKey,
  eventKey,
  eventTypesKey,
  metaFieldsKey,
  metricDefinitionKey,
  monitoringSeriesRangeKey,
  scanConfigKey,
} from '@/lib/queryKeys'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import type { EventType, FieldDefinition, MetaFieldDefinition } from '@/types'
import { AnnotationsCard } from './monitoring/AnnotationsCard'
import { BreakdownsTab } from './monitoring/BreakdownsTab'
import { DistributionTab, type DistributionScope } from './monitoring/DistributionTab'
import { EventDetailHero, EventDetailSkeleton } from './monitoring/event/EventDetailHero'
import { EventFieldsTable } from './monitoring/event/EventFieldsTable'
import { EventSideColumn } from './monitoring/event/EventSideColumn'
import { LIVE_STATUSES } from './monitoring/event/surface'
import { MetricHeaderActions } from './monitoring/MetricHeaderActions'
import { ChartCardHeader, MetricsRangeControls } from './monitoring/MetricsRangeControls'
import { useChartAnnotations } from './monitoring/useChartAnnotations'
import { useMetricCollect } from './monitoring/useMetricCollect'
import { useMonitoringDetailSearch, type MonitoringDetailTab } from './monitoring/useMonitoringDetailSearch'
import { VersionsTab } from './monitoring/VersionsTab'
import { usePageTitle } from '@/components/shell-chrome-context'

// Stable empty reference so `metaFieldsQuery.data ?? EMPTY_META_FIELDS`
// doesn't mint a new array each render and bust the memoized lookup map.
const EMPTY_META_FIELDS: MetaFieldDefinition[] = []

/**
 * One page, four scopes: an event, an event type, a scan's project total, and a
 * catalog metric. The page owns the queries that define the entity (the event,
 * the metric definition, the series); every secondary tab lives under
 * `pages/monitoring/` and owns its own query and error state (MON-35).
 */
export default function MonitoringDetailPage() {
  const { slug, scope: scopeParam, id, eventId } = useParams<{
    slug: string
    scope?: string
    id?: string
    eventId?: string
  }>()
  const navigate = useNavigate()
  const location = useLocation()
  // Edit, collect, delete and annotations are EditorUserDep; a viewer reads the
  // page without them instead of meeting each as a 403 (MON-6).
  const canWrite = useCanWriteProject()
  // Same history-first pop for both list-backed scopes, with the list as the
  // cold-start fallback: location.key is 'default' only when this page was
  // opened directly (deep link / refresh) with no in-app history to pop back to.
  const popOr = (fallback: string) => () => {
    if (location.key !== 'default') navigate(-1)
    else navigate(fallback)
  }
  // The legacy `/events/detail/:eventId` route carries no `:scope`; default to
  // the event scope when an eventId is present so the page never crashes on an
  // undefined scope (it now redirects to the canonical URL, but stay defensive).
  const scope = resolveDetailScope(scopeParam, eventId)
  // One page, THREE surfaces — the same three-way split navigation.ts makes for
  // these exact routes: `/monitoring/event/` is an Events drilldown,
  // `/monitoring/metric/` a Metrics one, and everything left under
  // `/monitoring/` (event-type, project-total) belongs to Anomalies (tripl-lkox).
  const backAffordance: { label: string; onClick: () => void }
    = scope === 'metric'
      ? { label: 'Back to metrics', onClick: () => navigate(`/p/${slug}/metrics`) }
      : scope === 'event'
        ? { label: 'Back to events', onClick: popOr(`/p/${slug}/events`) }
        : { label: 'Back to anomalies', onClick: popOr(`/p/${slug}/anomalies`) }

  // Tab, range, granularity and filters live in the URL (MON-24).
  const [search, searchActions] = useMonitoringDetailSearch()
  const { rangeDays } = search
  const metricsRef = useRef<HTMLDivElement>(null)

  const branchId = useActiveBranchId()
  const branchLink = useBranchLinkProps()
  const scopeId = id ?? eventId ?? ''
  // Reused by the header Edit button and the metric-scope Breakdowns empty state.
  const metricEditPath = `/p/${slug}/metrics/${scopeId}/edit`
  // Catalog metrics measure values (ratios, averages), not event volumes, so the
  // primary chart/tab reads "Value" for the metric scope and "Volume" elsewhere.
  const volumeLabel = scope === 'metric' ? 'Value' : 'Volume'

  // Follows the clock: the upper bound used to be pinned at mount, so a chart
  // left open never showed a bucket recorded after you opened it (tripl-jfm3.114).
  const timeRange = useLiveTimeRange(rangeDays * 24 * 60 * 60 * 1000)
  // Live-metric/monitoring queries fall back to polling only while the stream is
  // unavailable; metric_collection.updated / signals.updated refresh them live.
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })

  const eventQuery = useQuery({
    queryKey: eventKey(slug, branchId, scopeId),
    queryFn: () => eventsApi.get(slug!, scopeId, branchId),
    enabled: scope === 'event' && !!slug && !!scopeId,
    meta: SILENT_ERROR_META,
  })
  const event = eventQuery.data

  const historyQuery = useQuery({
    queryKey: eventHistoryKey(slug, branchId, scopeId),
    queryFn: () => eventsApi.history(slug!, scopeId, branchId),
    enabled: scope === 'event' && !!slug && !!scopeId,
    meta: SILENT_ERROR_META,
  })

  // Only the event and event-type pages read event types (the type's fields,
  // name and colour); a metric or project-total page used to download every
  // type with its field definitions, and blank itself if that failed (MON-37).
  const eventTypesQuery = useQuery({
    queryKey: eventTypesKey(slug, branchId),
    queryFn: () => eventTypesApi.list(slug!, branchId),
    enabled: !!slug && (scope === 'event' || scope === 'event_type'),
    meta: SILENT_ERROR_META,
  })
  const eventTypes = eventTypesQuery.data

  // Secondary: a failure only costs the meta-field labels, and the global
  // toast says so — it is not a reason to blank the page (MON-8).
  const metaFieldsQuery = useQuery({
    queryKey: metaFieldsKey(slug, branchId),
    queryFn: () => metaFieldsApi.list(slug!, branchId),
    enabled: scope === 'event' && !!slug,
  })
  const metaFields = metaFieldsQuery.data ?? EMPTY_META_FIELDS

  // Catalog metric definition (header / color / version-column) — only the
  // `metric` scope; the other scopes derive their title from event(-type) data.
  const metricDefinitionQuery = useQuery({
    queryKey: metricDefinitionKey(slug, scopeId),
    queryFn: () => metricsCatalogApi.get(slug!, scopeId),
    enabled: scope === 'metric' && !!slug && !!scopeId,
    meta: SILENT_ERROR_META,
  })
  const metricDefinition = metricDefinitionQuery.data
  // Owned here, not by the header's Collect button: that button unmounts when
  // the page swaps to its error state or canWrite flickers, and an in-progress
  // watch must outlive it.
  const metricCollect = useMetricCollect(scopeId)

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
  // One tooltip/aria label for every chart on this page: catalog metrics carry
  // their unit ('%', 'ms', …, falling back to 'value'); event scopes keep the
  // historical 'events'.
  const metricSeriesLabel = scope === 'metric' ? metricDefinition?.unit || 'value' : 'events'
  // Event volumes sum into a coarser bucket; a ratio, average or percentage
  // metric averages instead (MON-2 / MET-12).
  const rollupMode = scope === 'metric' ? metricRollupMode(metricDefinition) : 'sum'
  // Until a metric's definition arrives its rollup is unknown: anything drawn
  // with the 'sum' fallback would show a ratio metric summed, then snap.
  const rollupPending = scope === 'metric' && metricDefinitionQuery.isPending

  const metricsQuery = useQuery({
    // Keyed on the range length, not the live bounds: the bound steps every five
    // minutes, and the query function reads the current window on each fetch.
    queryKey: monitoringSeriesRangeKey(slug, scope, scopeId, rangeDays),
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
    refetchInterval,
    // Keep the previous range's series on screen while the new range loads so the
    // chart doesn't remount into a loading flash on range change (tripl-7l83.10).
    placeholderData: keepPreviousData,
    meta: SILENT_ERROR_META,
  })
  const metrics = metricsQuery.data
  // One default rule for every scope (MON-43): the range's readable default,
  // never finer than the collection interval. A manual pick wins and stays
  // sticky across range changes — but is bumped coarser when it would draw more
  // points than a chart can take over the new range (MON-23).
  // The collection interval's own granularity is exempt from that cap, so a
  // 15 min series can still be read at 15 min with its band and forecast.
  const nativeGranularity = granularityForInterval(metrics?.interval)
  const defaultGranularity = defaultDrilldownGranularity(rangeDays, metrics?.interval)
  const granularity = clampGranularityToRange(
    search.granularity ?? defaultGranularity,
    rangeDays,
    nativeGranularity,
  )
  // A pick equal to the default stays out of the URL, like every other param.
  const setGranularity = (next: MetricsGranularity) =>
    searchActions.setGranularity(next, defaultGranularity)
  const scanConfigId = metrics?.scan_config_id ?? (scope === 'project_total' ? scopeId : null)

  // Secondary: without it the By version tab stays hidden, and the global toast
  // names the failure (MON-8).
  const scanConfigQuery = useQuery({
    queryKey: scanConfigKey(slug, scanConfigId),
    queryFn: () => scansApi.get(slug!, scanConfigId!),
    enabled: scope !== 'metric' && !!slug && !!scanConfigId,
  })
  // Catalog metrics expose their version column on the definition; the other
  // scopes read it off the resolved scan config.
  const hasVersionColumn = scope === 'metric'
    ? Boolean(metricDefinition?.app_version_column)
    : Boolean(scanConfigQuery.data?.app_version_column)
  // Which tabs this scope actually renders a trigger for — kept in step with
  // the TabsList below. A URL can ask for any of them, so the fallback has to
  // cover every absent tab: a value with no trigger leaves an empty page.
  const availableTabs = useMemo<MonitoringDetailTab[]>(
    () => [
      'volume',
      ...(hasVersionColumn ? (['versions'] as const) : []),
      ...(scope !== 'metric' ? (['heatmap', 'distribution'] as const) : []),
      ...(scope === 'event' || scope === 'metric' ? (['breakdowns'] as const) : []),
    ],
    [hasVersionColumn, scope],
  )
  const selectedTab: MonitoringDetailTab = availableTabs.includes(search.tab) ? search.tab : 'volume'

  const eventDistributionEventTypeId = event?.event_type_id ?? null
  const distributionScope = useMemo<DistributionScope | null>(() => {
    if (scope === 'project_total' && scopeId) {
      return { scope_type: 'project_total', scope_ref: scopeId, scan_config_id: scopeId }
    }
    if (scope === 'event_type' && scopeId) {
      return { scope_type: 'event_type', scope_ref: scopeId }
    }
    if (scope === 'event' && eventDistributionEventTypeId) {
      return { scope_type: 'event_type', scope_ref: eventDistributionEventTypeId }
    }
    return null
  }, [eventDistributionEventTypeId, scope, scopeId])

  const chartData = useMemo(
    () => aggregateMetricPoints(metrics?.data ?? [], granularity, rollupMode),
    [granularity, metrics?.data, rollupMode],
  )
  // The API forecasts exactly one native collection bucket. Once actuals are
  // rolled up (for example 1h -> day), that single point is not a forecast for
  // the whole display bucket and can even duplicate the last x-axis date.
  const chartForecast = nativeGranularity === granularity
    ? metrics?.forecast
    : undefined

  const annotationsQuery = useChartAnnotations({ slug, scope, scopeId, rangeDays, timeRange })

  const eventType = (eventTypes ?? []).find((candidate: EventType) => (
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
    // The label an analyst wrote leads when there is one; the identity the scan
    // matches on then sits beneath it in mono (tripl-kjhi.3).
    return event?.title || (event?.name ?? 'Event')
  })()
  // The top bar names the entity once it has loaded, not the generic fallback.
  const titleEntity = scope === 'metric' ? metricDefinition : scope === 'event_type' ? eventType : scope === 'event' ? event : scope
  usePageTitle(titleEntity ? headerTitle : null)
  const headerIdentity = scope === 'event' && event?.title ? (event.source_name || event.name) : null
  const headerDescription = (() => {
    if (scope === 'metric') return metricDefinition?.description || 'Catalog metric monitoring detail.'
    if (scope === 'project_total') return 'Canonical total event volume for the selected scan.'
    if (scope === 'event_type') return eventType?.description || 'Aggregated volume for the event type.'
    return event?.description || 'Monitoring detail for the selected event.'
  })()
  const latestSignal = metrics?.latest_signal
  const latestSignalBadgeClassName = latestSignal?.state === 'recent'
    ? 'gap-1 border-warning/50 bg-warning-soft text-warning'
    : 'gap-1'
  const latestSignalLabel = latestSignal
    ? `${latestSignal.state === 'recent' ? 'Recent' : 'Latest scan'} ${latestSignal.direction === 'drop' ? 'drop' : 'spike'} anomaly`
    : null

  const isEventScope = scope === 'event'
  const containerClassName = isEventScope
    ? 'mx-auto max-w-[1000px] space-y-5 px-4 pb-12 pt-4 sm:px-6'
    : 'space-y-6 p-4 sm:p-6'

  // Only the queries that define the entity blank the page; every tab renders
  // its own failure inside itself (MON-8). A disabled query never errors, so
  // the list covers every scope.
  const entityQueries = [eventQuery, eventTypesQuery, metricDefinitionQuery, metricsQuery]
  const failedEntityQuery = entityQueries.find(query => query.isError)
  if (failedEntityQuery) {
    return (
      <div className={containerClassName}>
        <ErrorState
          title="Failed to load monitoring details"
          description="The monitoring page could not fetch data from the backend."
          error={failedEntityQuery.error}
          // Retry exactly what failed: the metric definition was never retried
          // before, and refetching a disabled query ignores `enabled` and fired
          // a request with a null scan id (MON-7).
          onRetry={() => {
            for (const query of entityQueries) {
              if (query.isError) void query.refetch()
            }
          }}
        />
      </div>
    )
  }

  // The event hero, not the generic header, is what an event page settles into;
  // painting the generic one first made the layout jump (MON-9).
  if (isEventScope && !event) {
    return (
      <div className={containerClassName}>
        <EventDetailSkeleton />
      </div>
    )
  }

  const chartIsLoading = metricsQuery.isLoading
    // A metric's rollup depends on its definition; charting before it arrives
    // would draw a sum and then snap to a mean.
    || rollupPending

  return (
    <div className={containerClassName}>
      {isEventScope && event ? (
        <EventDetailHero
          slug={slug ?? ''}
          event={event}
          eventType={eventType}
          metrics={metrics}
          // Branch-aware: a bare path would drop the branch out of the URL and
          // leave the editor relying on context alone (tripl-h2sx.2).
          onEdit={canWrite ? () => {
            const link = branchLink(
              `/p/${slug}/events/${event.event_type?.name ?? 'all'}/${event.id}/edit`,
              event.branch_id ?? branchId,
            )
            link.onClick()
            navigate(link.to)
          } : undefined}
          onMetrics={() => metricsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={backAffordance.onClick}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              {backAffordance.label}
            </Button>
            {scope === 'metric' && canWrite && slug && (
              <MetricHeaderActions
                slug={slug}
                scopeId={scopeId}
                metricDefinition={metricDefinition}
                editPath={metricEditPath}
                collect={metricCollect}
              />
            )}
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="min-w-0 break-words text-[22px] font-semibold tracking-[-0.01em]">{headerTitle}</h1>
              {headerIdentity && (
                <span className="mono text-[13px]" style={{ color: 'var(--fg-muted)' }} data-testid="header-identity">
                  {headerIdentity}
                </span>
              )}
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

      {isEventScope && event && slug && (
        <EntityBranchBanner
          slug={slug}
          rowBranchId={event.branch_id}
          path={`/p/${slug}/monitoring/event/${event.id}`}
        />
      )}

      {/* The spec comes first for an event that is not yet live: that page is
          where a developer is sent to instrument it, and the metrics below can
          only say "no data" until they have (tripl-kjhi.8). Once the event is
          live the chart leads and the spec follows the fields. */}
      {isEventScope && event && slug && !LIVE_STATUSES.has(event.status) && (
        <EventSpecCard slug={slug} event={event} eventType={eventType} metaFieldMap={metaFieldMap} />
      )}

      {isEventScope && event && (
        // grid-cols-1 is minmax(0, 1fr): an auto column grew to the Fields
        // table's width on a phone and the page scrolled sideways (LIVE-5).
        <div className="grid grid-cols-1 items-start gap-[14px] lg:grid-cols-[1.5fr_1fr] [&>*]:min-w-0">
          <EventFieldsTable eventType={eventType} event={event} fieldDefMap={fieldDefMap} />
          <EventSideColumn
            slug={slug ?? ''}
            event={event}
            eventType={eventType}
            history={historyQuery.data ?? []}
            historyError={historyQuery.isError ? historyQuery.error : undefined}
            onRetryHistory={() => void historyQuery.refetch()}
            metaFieldMap={metaFieldMap}
          />
        </div>
      )}

      {isEventScope && event && slug && LIVE_STATUSES.has(event.status) && (
        <EventSpecCard slug={slug} event={event} eventType={eventType} metaFieldMap={metaFieldMap} />
      )}

      {/* The hero's "Metrics" action scrolls here. The anchor used to be a
          separate span with -mt-5, which cancelled the page gap and glued the
          tab strip to the card above it (LIVE-12). */}
      <div ref={metricsRef} className="min-w-0 scroll-mt-4">
        <Tabs value={selectedTab} onValueChange={value => searchActions.setTab(value as MonitoringDetailTab)}>
          {/* The strip scrolls on its own on a phone instead of widening the
              page: five triggers do not fit 375px (LIVE-5). */}
          <div className="tripl-scroll-x -mx-1 overflow-x-auto px-1">
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
          </div>

          <TabsContent value="volume" className="space-y-6">
            {latestSignal && (
              <Card>
                <CardContent className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
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
                        : // Value-aware: a non-percent metric can still carry a
                          // sub-unit baseline, which plain rounding wrote as "0".
                          formatIncidentCount(latestSignal.expected_count)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Z-Score</p>
                    <p className="text-sm font-medium">{latestSignal.z_score.toFixed(2)}</p>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* scan_config_id is NULL only for metric-scope signals, which the
                scope guard already excludes — but it is checked rather than
                asserted, so a future scope that also lacks one cannot put a null
                into the query key. */}
            {latestSignal?.scan_config_id && slug && scope !== 'metric' && (
              <TopMoversPanel
                slug={slug}
                scanConfigId={latestSignal.scan_config_id}
                scopeType={latestSignal.scope_type}
                scopeRef={latestSignal.scope_ref}
                bucket={latestSignal.bucket}
                rangeDays={rangeDays}
                timeRange={timeRange}
              />
            )}

            <Card>
              <CardContent className="p-4 sm:p-6">
                <ChartCardHeader title={<h2 className="text-lg font-semibold">{volumeLabel}</h2>}>
                  <MetricsRangeControls
                    rangeDays={rangeDays}
                    granularity={granularity}
                    nativeGranularity={nativeGranularity}
                    onRangeDaysChange={searchActions.setRangeDays}
                    onGranularityChange={setGranularity}
                  />
                </ChartCardHeader>
                {chartIsLoading ? (
                  <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">
                    Loading monitoring data…
                  </div>
                ) : chartData.length === 0 ? (
                  <div className="h-[200px] flex items-center justify-center">
                    <EmptyState
                      icon={TrendingUp}
                      title="No metrics data available"
                      description="Run a scan to start collecting volume metrics for this scope."
                    />
                  </div>
                ) : (
                  <MetricsChart
                    data={chartData}
                    forecast={chartForecast}
                    annotations={annotationsQuery.data ?? []}
                    height={200}
                    color={eventType?.color || metricDefinition?.color || 'var(--chart-3)'}
                    granularity={granularity}
                    seriesLabel={metricSeriesLabel}
                    valueFormatter={metricValueFormatter}
                    // The sigma the detector scored THIS scope with, so the band
                    // and the "±Nσ" tooltip agree with the dots inside them. The
                    // metric scope serves it too (`adaptMetricSeries`, tripl-4cgl).
                    sigmaThreshold={metrics?.sigma_threshold}
                  />
                )}
                {metrics?.interval && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Collection interval: {metrics.interval}
                  </p>
                )}
              </CardContent>
            </Card>

            {slug && (
              <AnnotationsCard
                slug={slug}
                scope={scope}
                scopeId={scopeId}
                canWrite={canWrite}
                query={annotationsQuery}
              />
            )}
          </TabsContent>

          {hasVersionColumn && slug && (
            <TabsContent value="versions" className="space-y-4">
              <VersionsTab
                slug={slug}
                scope={scope}
                scopeId={scopeId}
                scanConfigId={scanConfigId}
                rangeDays={rangeDays}
                timeRange={timeRange}
                granularity={granularity}
                nativeGranularity={nativeGranularity}
                rollupMode={rollupMode}
                refetchInterval={refetchInterval}
                versionFilter={search.versionFilter}
                seriesLabel={metricSeriesLabel}
                valueFormatter={metricValueFormatter}
                onRangeDaysChange={searchActions.setRangeDays}
                onGranularityChange={setGranularity}
                onVersionFilterChange={searchActions.setVersionFilter}
              />
            </TabsContent>
          )}

          <TabsContent value="heatmap">
            {metrics?.scan_config_id ? (
              <SeasonalityHeatmap
                slug={slug!}
                scanConfigId={metrics.scan_config_id}
                scopeType={scope}
                scopeRef={scopeId}
                rangeDays={rangeDays}
                timeRange={timeRange}
                color={eventType?.color || 'var(--chart-3)'}
              />
            ) : (
              <Card>
                <CardContent className="p-6 text-sm text-muted-foreground">
                  No scan found for this scope yet — run a scan to populate
                  the heatmap.
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {slug && (
            <TabsContent value="distribution">
              <DistributionTab
                slug={slug}
                distributionScope={distributionScope}
                rangeDays={rangeDays}
                timeRange={timeRange}
                refetchInterval={refetchInterval}
                selectedField={search.distributionField}
                onSelectedFieldChange={searchActions.setDistributionField}
              />
            </TabsContent>
          )}

          {slug && (scope === 'event' || scope === 'metric') && (
            <TabsContent value="breakdowns">
              {rollupPending ? (
                // Same reason as the volume chart: no summed values for a
                // ratio metric while its definition is on the way.
                <Card>
                  <CardContent className="p-6 text-sm text-muted-foreground">
                    Loading breakdowns…
                  </CardContent>
                </Card>
              ) : (
                <BreakdownsTab
                  slug={slug}
                  scope={scope}
                  scopeId={scopeId}
                  rangeDays={rangeDays}
                  timeRange={timeRange}
                  granularity={granularity}
                  rollupMode={rollupMode}
                  refetchInterval={refetchInterval}
                  column={search.breakdownColumn}
                  selectedValues={search.breakdownValues}
                  seriesLabel={metricSeriesLabel}
                  valueFormatter={metricValueFormatter}
                  metricEditPath={metricEditPath}
                  onColumnChange={searchActions.setBreakdownColumn}
                  onSelectedValuesChange={searchActions.setBreakdownValues}
                />
              )}
            </TabsContent>
          )}
        </Tabs>
      </div>

      {scope === 'event' && scopeId && (
        <EventValueDriftPanel slug={slug!} eventId={scopeId} />
      )}
      {scope === 'event' && scopeId && (
        <EventPhotosSection slug={slug!} eventId={scopeId} />
      )}
    </div>
  )
}
