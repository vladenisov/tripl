import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  Bell,
  Check,
  Database,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'
import { activityApi } from '@/api/activity'
import { useActivityRailInline } from '@/components/activity-panel'
import { ApiError } from '@/api/client'
import { dataSourcesApi } from '@/api/dataSources'
import { eventMetricsApi } from '@/api/eventMetrics'
import { projectsApi } from '@/api/projects'
import NotFoundPage from '@/pages/NotFoundPage'
import { ErrorState } from '@/components/error-state'
import { OnboardingChecklist } from '@/components/onboarding-checklist'
import { countRealSources } from '@/components/onboarding-utils'
import { SyntheticSourceBadge } from '@/demo/capabilityBadges'
import { DemoWelcomePanel } from '@/demo/DemoWelcomePanel'
import { Dot } from '@/components/primitives/dot'
import { MiniStat, MiniStatStrip } from '@/components/primitives/mini-stat'
import { Sparkline } from '@/components/primitives/sparkline'
import { Panel } from '@/components/settings/kit'
import { PageContainer } from '@/components/primitives/page-container'
import { PageHeader } from '@/components/primitives/page-header'
import { LoadingState } from '@/components/primitives/loading-state'
import { SERIES_COLORS } from '@/components/ui/chart-format'
import { Skeleton } from '@/components/ui/skeleton'
import { useTheme } from '@/components/theme-provider'
import { formatPlanCoverage, planCoverageRatio } from '@/lib/coverage'
import {
  coverageTone,
  dataSourceHealthLexeme,
  signalDirectionColor,
  signalDirectionTone,
  type StatusLexeme,
} from '@/lib/statusLexicon'
import { formatDateTime, formatRelativeTime } from '@/lib/datetime'
import { formatNumber } from '@/lib/format'
import { formatSignalSeverity, getMonitoringPath } from '@/lib/monitoring'
import { selectSignificantSignals } from '@/lib/signalMagnitude'
import { formatSignalValues } from '@/lib/signalMetricFormat'
import { friendlyScanError } from '@/lib/scanError'
import { useExpandedSignals } from '@/hooks/useExpandedSignals'
import { useLiveTimeRange } from '@/hooks/useLiveTimeRange'
import {
  signalScopeLabel,
  signalScopeRefLabel,
  unnamedScopeLabel,
} from '@/lib/signalScope'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import type {
  ActivityItem,
  ActivityItemSeverity,
  ActivityItemType,
  DataSource,
  MonitoringSignal,
} from '@/types'
import {
  activityPreviewKey,
  dataSourcesKey,
  overviewKpiSeriesKey,
  overviewTopEventsKey,
  overviewVolumeKey,
  projectKey,
} from '@/lib/queryKeys'

const SIGNAL_LIMIT = 6
const ACTIVITY_LIMIT = 8
// The magnitude gate lives in @/lib/signalMagnitude, shared with AnomaliesPage,
// the top-bar bell and the backend's metrics_insights_service. Gating the "Open
// signals" headline on it keeps the number equal to the sidebar badge (project
// summary monitoring_signal_count) and the Anomalies page's default
// "Significant" view (issue tripl-yfsj.1).
// A successful source connection test older than this is shown as "stale" rather
// than a confident "healthy" — an old green check is misleading (issue M1).
const SOURCE_HEALTH_STALE_MS = 24 * 60 * 60 * 1000
// The volume card asked for the scan's ENTIRE metric history — the endpoint's
// from/to simply were never passed — so it was still fetching 2.2 s after every
// other panel on the page had rendered (tripl-jfjt). Seven days matches the
// documented default window for project-total charts.
const VOLUME_WINDOW_DAYS = 7
const VOLUME_WINDOW_MS = VOLUME_WINDOW_DAYS * 24 * 60 * 60 * 1000
const VOLUME_SUBTITLE = 'One scan — not the project’s combined volume across all scans.'

export default function OverviewPage() {
  const { slug } = useParams<{ slug: string }>()
  const { chartStyle } = useTheme()
  // Adaptive fallback cadence: the live stream refreshes signals/activity via the
  // invalidation map, so poll only while the stream is unavailable.
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })

  const projectQuery = useQuery({
    queryKey: projectKey(slug),
    queryFn: () => projectsApi.get(slug!),
    enabled: !!slug,
  })
  // A live bound rather than a mount-time snapshot, so a long-open tab keeps
  // asking for the current 7 days (tripl-jfm3.114).
  const volumeRange = useLiveTimeRange(VOLUME_WINDOW_MS)
  // The project query is the single authority on whether the slug exists. Gate
  // every project-scoped widget query on its success so they never fan out
  // 404s against a nonexistent project (issue .9).
  const volumeQuery = useQuery({
    // The window length is in the key but its moving bounds are NOT: every
    // refetch reads the live range, while keying on `to` would mint a fresh
    // cache entry — and drop the card back to its skeleton — every five
    // minutes. Same split as MonitoringDetailPage's metricsQuery.
    queryKey: overviewVolumeKey(slug, VOLUME_WINDOW_DAYS),
    queryFn: () => eventMetricsApi.getProjectTotalMetrics(slug!, volumeRange),
    enabled: !!slug && projectQuery.isSuccess,
    staleTime: 60_000,
  })
  const topEventsQuery = useQuery({
    queryKey: overviewTopEventsKey(slug),
    queryFn: () => eventMetricsApi.getTopEvents(slug!, { windowHours: 48, limit: 6 }),
    enabled: !!slug && projectQuery.isSuccess,
    staleTime: 60_000,
  })
  const kpiSeriesQuery = useQuery({
    queryKey: overviewKpiSeriesKey(slug),
    queryFn: () => eventMetricsApi.getOverviewKpiSeries(slug!, 14),
    enabled: !!slug && projectQuery.isSuccess,
    staleTime: 60_000,
  })
  // Expanded (all scopes, incident children tagged) so the headline count matches
  // the sidebar badge and the Anomalies page rather than only project-total /
  // event-type incidents (issue tripl-yfsj.1). Shared key with the top bar and
  // the Anomalies page (tripl-jfm3.119).
  const signalsQuery = useExpandedSignals(slug, { enabled: projectQuery.isSuccess })
  // With the rail open inline beside the page, the page's own "Recent activity"
  // panel listed the same items a second time, side by side (LIVE-10). The
  // panel steps aside while the rail is there and comes back when it closes.
  const railShowsActivity = useActivityRailInline()
  const activityQuery = useQuery({
    // Its own key under the rail's: the two asked for different page sizes
    // under ONE key, so whichever fetched last set the length of both lists.
    queryKey: activityPreviewKey(slug, ACTIVITY_LIMIT),
    queryFn: () => activityApi.list({ slug, limit: ACTIVITY_LIMIT }),
    enabled: !!slug && projectQuery.isSuccess && !railShowsActivity,
    staleTime: 30_000,
    refetchInterval,
  })
  const sourcesQuery = useQuery({
    queryKey: dataSourcesKey(),
    queryFn: dataSourcesApi.list,
  })

  const summary = projectQuery.data?.summary
  const projectId = projectQuery.data?.id
  const volumePoints = volumeQuery.data?.data ?? []
  const volumeCounts = volumePoints.map((p) => p.count)
  const topEvents = topEventsQuery.data ?? []
  const maxTopVolume = topEvents.reduce((m, e) => Math.max(m, e.total_count), 0)
  // Match the AnomaliesPage default "Significant" view so the "Open signals"
  // headline, the sidebar badge (monitoring_signal_count) and the Anomalies page
  // all report the same count (issue tripl-yfsj.1). Sorted biggest-effect-first so
  // the capped panel previews the top anomalies.
  const signals = selectSignificantSignals(signalsQuery.data)
  const activity = activityQuery.data ?? []
  // Scope the Source-health rail to this project: workspace-global sources
  // (project_id == null) plus sources owned by the current project. Without this
  // a demo project's project-scoped synthetic source leaks into unrelated
  // projects (issue .14). Falls back to the full list until the project loads.
  const allSources = sourcesQuery.data ?? []
  const sources = projectId
    ? allSources.filter((s) => s.project_id == null || s.project_id === projectId)
    : allSources

  // "Open signals" comes from the SAME array the panel below renders (issue H1) —
  // now the significant, all-scope signals — so the headline equals the sidebar
  // badge (monitoring_signal_count) and the Anomalies page (issue tripl-yfsj.1).
  const signalCount = signals.length
  const reviewCount = summary?.review_pending_event_count ?? 0
  // Coverage is plan coverage (implemented vs active events) rendered through the
  // canonical formatter, so it reads identically to the projects dashboard (H2).
  const coveragePct = summary
    ? planCoverageRatio(summary.implemented_event_count, summary.active_event_count) * 100
    : undefined
  // Events CREATED per day (main branch) — NOT a history of the "Active events"
  // stat beside it. The series was captioned "Active trend" / "Active events by
  // day" while a single day could exceed the whole active catalog (4,618 on a
  // project with 2,413 active events); the caption now says what the numbers are
  // (tripl-jfm3.22, tripl-jfm3.77).
  const newEventsSeries = kpiSeriesQuery.data?.new_events ?? []
  // The volume card charts ONE scan config (summing every scan double-counts the
  // events a legacy/backfill scan also collected), so it names that scan instead
  // of claiming to be the project total (tripl-jfm3.20).
  const volumeScanName = volumeQuery.data?.scan_config_name ?? null
  // Present exactly when a scan config was resolved, which is what separates
  // "this scan collected nothing in the window" from "nothing collects at all"
  // — the backend returns a bare empty series with no scan id in the second
  // case (metrics_service.get_project_total_metrics).
  const volumeScanConfigId = volumeQuery.data?.scan_config_id ?? null
  // `isPending`, not `isLoading`: while the query waits on the projectQuery gate
  // it is pending but NOT fetching, so an `isLoading` check let the card claim
  // "No volume data yet." before it had even asked (tripl-jfjt).
  const isVolumePending = volumeQuery.isPending && !projectQuery.isError

  // A nonexistent slug is a 404 on the project query itself: replace the whole
  // widget grid with the app's full-page not-found (issue .9). Non-404 project
  // failures (500/503) keep the compact KPI-strip ErrorState below so a transient
  // outage is not misreported as a missing project.
  if (projectQuery.error instanceof ApiError && projectQuery.error.status === 404) {
    return <NotFoundPage />
  }

  return (
    <PageContainer>
      {/* A freshly-created demo lands here (not Events): orient the user and
          launch the tour before anything else. */}
      {projectQuery.data?.is_demo && <DemoWelcomePanel project={projectQuery.data} />}

      {/* Guided first-run checklist (UX-24) — a "start here" for the core
          Plan → Observe → Govern loop. Self-derives done-state from REAL project
          data, is dismissible, and auto-hides once complete. Synthetic demo
          sources are excluded from the "connect a source" step. */}
      {slug && (
        <OnboardingChecklist
          slug={slug}
          projectId={projectQuery.data?.id}
          summary={summary}
          sourceCount={countRealSources(sources)}
          isDemo={projectQuery.data?.is_demo}
        />
      )}

      {/* Header. The eyebrow is the nav group, never the project name: the
          top bar's breadcrumb already carries that (DS-2 / MO-40). */}
      <PageHeader eyebrow="Observe" title="Live activity" />


      {/* KPI strip */}
      {projectQuery.isError ? (
        <ErrorState
          title="Overview unavailable"
          error={projectQuery.error}
          onRetry={() => {
            void projectQuery.refetch()
          }}
          retryLabel="Retry"
          compact
        />
      ) : (
        <MiniStatStrip boxed>
          <MiniStat
            label="Active events"
            value={summary ? formatNumber(summary.active_event_count) : '—'}
          />
          <MiniStat
            label="Implemented"
            value={summary ? formatNumber(summary.implemented_event_count) : '—'}
            tone="success"
          />
          <MiniStat
            label="Needs review"
            value={summary ? formatNumber(reviewCount) : '—'}
            tone={reviewCount > 0 ? 'warning' : 'neutral'}
          />
          <MiniStat
            label="Open signals"
            value={signalsQuery.data ? formatNumber(signalCount) : '—'}
            tone={signalCount > 0 ? 'danger' : 'success'}
            pulse={signalCount > 0}
            delta={signalCount > 0 ? 'active' : undefined}
          />
          <MiniStat
            label="Coverage"
            value={
              summary
                ? formatPlanCoverage(summary.implemented_event_count, summary.active_event_count)
                : '—'
            }
            tone={coverageTone(coveragePct)}
          />
          {newEventsSeries.length > 1 && (
            <>
              {/* Stacked like the MiniStat columns (caption above, figure below):
                  same `gap-px` label→figure rhythm and a 24px figure so the top
                  caption sits on the same baseline as the numeric stats in this
                  `items-center` row. `shrink-0` keeps its room when the strip
                  wraps, and `pr-1` lifts the line off the card edge (the SVG draws
                  to x=width with overflow visible) so it reads as a finished stat
                  rather than a stray line crammed against the edge. Tooltip +
                  role="img" alt spell out what the line is (issue #12). */}
              <div
                className="m-0 flex shrink-0 flex-col gap-px pr-1"
                title="New events added per day over the last 14 days"
              >
                <span
                  className="micro-label"
                  style={{ color: 'var(--fg-faint)' }}
                >
                  New events · 14d
                </span>
                <div role="img" aria-label={newEventsTrendLabel(newEventsSeries)}>
                  <Sparkline
                    data={newEventsSeries}
                    variant={chartStyle}
                    width={120}
                    height={24}
                  />
                  <span className="sr-only">
                    New events added by day: {newEventsSeries.map((c) => formatNumber(c)).join(', ')}.
                  </span>
                </div>
              </div>
            </>
          )}
        </MiniStatStrip>
      )}

      {/* Volume — one scan config, named. Labelled "project total" until
          tripl-jfm3.20, where it plotted 2.4 % of windy-ios's volume directly
          above a "Top events" row 12× larger. */}
      <Panel
        // The window is in the title because the card is capped at it and says
        // so nowhere else — the caption reads "latest bucket · N buckets" and
        // the sibling panel below already names its own ("Top events · 48h").
        title={
          volumeScanName
            ? `Volume · ${volumeScanName} · ${VOLUME_WINDOW_DAYS}d`
            : `Volume · ${VOLUME_WINDOW_DAYS}d`
        }
        // Held through the pending state as well, so the header keeps its second
        // line instead of growing one when the series lands (tripl-jfjt).
        subtitle={volumeScanName || isVolumePending ? VOLUME_SUBTITLE : undefined}
      >
        <div className="p-4">
        {volumeQuery.isError && (
          <ErrorState
            title="Volume unavailable"
            error={volumeQuery.error}
            onRetry={() => {
              void volumeQuery.refetch()
            }}
            retryLabel="Retry"
            compact
          />
        )}
        {!volumeQuery.isError && isVolumePending && <VolumeSkeleton />}
        {!volumeQuery.isError && !isVolumePending && volumePoints.length === 0 && (
          // Two different facts, and the card used to report only the second.
          // A scan whose last bucket predates the window has months of history
          // and nothing here — that is a scan that stopped, the state the
          // failing-scan chip above exists to surface, not an empty project.
          // The drilldown carries a range selector, so it can show the rest.
          <div className="text-body-sm" style={{ color: 'var(--fg-subtle)' }}>
            {volumeScanConfigId ? (
              <>
                No volume in the last {VOLUME_WINDOW_DAYS} days.{' '}
                <Link
                  to={getMonitoringPath(slug!, {
                    scope_type: 'project_total',
                    scope_ref: volumeScanConfigId,
                  })}
                  style={{ color: 'var(--accent)' }}
                >
                  See this scan’s full history
                </Link>
              </>
            ) : (
              'No volume data yet.'
            )}
          </div>
        )}
        {volumePoints.length > 0 && (
          // The chart takes the rest of the row and scales to it. A fixed 320px
          // SVG beside the figure ran off the card on a phone, cutting off the
          // newest buckets, and left half of a wide card empty (MON-33, LIVE-29).
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <div
              role="group"
              aria-label={`Latest bucket volume ${formatNumber(volumeCounts[volumeCounts.length - 1]!)}, ${volumePoints.length} buckets`}
              className="flex shrink-0 flex-col gap-px"
            >
              {/* The hero figure: sans with tabular digits (DS-17) on the
                  display step of the type scale (DS-13). */}
              <span className="tnum text-display font-semibold">
                {formatNumber(volumeCounts[volumeCounts.length - 1]!)}
              </span>
              <span className="text-caption" style={{ color: 'var(--fg-subtle)' }}>
                latest bucket · {volumePoints.length} buckets
              </span>
            </div>
            <div
              role="img"
              aria-label={volumeChartLabel(volumeCounts, volumeScanName)}
              className="min-w-[8rem] flex-1"
            >
              <Sparkline data={volumeCounts} variant={chartStyle} width={320} height={48} responsive />
              <span className="sr-only">
                Volume by bucket: {volumeCounts.map((c) => formatNumber(c)).join(', ')}.
              </span>
            </div>
          </div>
        )}
        </div>
      </Panel>

      {/* Top events by volume — summed across EVERY scan config, unlike the
          volume card above it, which charts one. Saying so is what stops the
          two panels reading as a contradiction (tripl-jfm3.20). */}
      <Panel title="Top events · 48h" subtitle="Across every scan in this project.">
        <div className="p-4">
        {topEventsQuery.isError && (
          <ErrorState
            title="Top events unavailable"
            error={topEventsQuery.error}
            onRetry={() => {
              void topEventsQuery.refetch()
            }}
            retryLabel="Retry"
            compact
          />
        )}
        {!topEventsQuery.isError && topEvents.length === 0 && (
          <div className="text-body-sm" style={{ color: 'var(--fg-subtle)' }}>
            {topEventsQuery.isLoading ? <LoadingState as="span" /> : 'No event volume in the last 48 hours.'}
          </div>
        )}
        {topEvents.length > 0 && (
          <div role="list" aria-label="Top events by volume, last 48 hours" className="space-y-1.5">
            {topEvents.map((e) => (
              <div
                key={e.event_id}
                role="listitem"
                aria-label={`${e.name}: ${formatNumber(e.total_count)} events`}
                className="flex items-center gap-3"
              >
                {/* The label column grows with the panel instead of sitting at
                    a fixed 10rem. Event names share long prefixes
                    (`feature_flag:flag_use:app` vs `…:growthbook`), so a fixed
                    column truncated the top rows to one identical string and
                    the ranking became unreadable (tripl-jfm3.31). Capped so the
                    bar track still carries the comparison. */}
                {/* Sans: an event name is a display name, not code (DS-17). */}
                <span
                  className="w-[min(45%,22rem)] shrink-0 truncate text-body-sm"
                  title={e.name}
                >
                  {e.name}
                </span>
                <div
                  aria-hidden="true"
                  className="relative h-2 flex-1 overflow-hidden rounded-full"
                  style={{ background: 'var(--surface-active)' }}
                >
                  <div
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                      width: `${maxTopVolume > 0 ? (e.total_count / maxTopVolume) * 100 : 0}%`,
                      background: SERIES_COLORS[0],
                    }}
                  />
                </div>
                <span
                  className="tnum w-16 shrink-0 text-right text-caption"
                  style={{ color: 'var(--fg-subtle)' }}
                >
                  {formatNumber(e.total_count)}
                </span>
              </div>
            ))}
          </div>
        )}
        </div>
      </Panel>

      {/* Active signals. Capped at SIGNAL_LIMIT rows while the headline can
          count dozens, so the full list is one click away (MON-15). */}
      <Panel
        title="Active signals"
        right={
          slug && signals.length > 0 ? (
            <Link
              to={`/p/${slug}/anomalies`}
              className="rounded-md px-2 py-1 text-body-sm no-underline transition-colors hover:bg-[var(--surface-hover)]"
              style={{ color: 'var(--accent)' }}
            >
              View all ({formatNumber(signals.length)})
            </Link>
          ) : undefined
        }
      >
        <div className="p-4">
        {signalsQuery.isError && (
          <ErrorState
            title="Signals unavailable"
            error={signalsQuery.error}
            onRetry={() => {
              void signalsQuery.refetch()
            }}
            retryLabel="Retry"
            compact
          />
        )}
        {!signalsQuery.isError && signals.length === 0 && (
          <div className="text-body-sm" style={{ color: 'var(--fg-subtle)' }}>
            {signalsQuery.isLoading ? <LoadingState as="span" /> : 'No active monitoring signals.'}
          </div>
        )}
        {signals.length > 0 && slug && (
          <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
            {signals.slice(0, SIGNAL_LIMIT).map((signal) => (
              <SignalRow
                // Signals are per scan config: two scans watching one event
                // each open their own, and a scope-only key collided (MON-16).
                key={`${signal.scan_config_id ?? 'metric'}:${signal.scope_type}:${signal.scope_ref}:${signal.bucket}`}
                slug={slug}
                signal={signal}
              />
            ))}
          </div>
        )}
        </div>
      </Panel>

      {/* Recent activity — not while the rail shows the same feed beside it. */}
      {!railShowsActivity && (
      <Panel title="Recent activity">
        <div className="p-4">
        {activityQuery.isError && (
          <ErrorState
            title="Activity unavailable"
            error={activityQuery.error}
            onRetry={() => {
              void activityQuery.refetch()
            }}
            retryLabel="Retry"
            compact
          />
        )}
        {!activityQuery.isError && activity.length === 0 && (
          <div className="text-body-sm" style={{ color: 'var(--fg-subtle)' }}>
            {activityQuery.isLoading ? <LoadingState as="span" /> : 'No recent activity.'}
          </div>
        )}
        {activity.length > 0 && (
          <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
            {activity.map((item) => (
              <ActivityRow key={item.id} item={item} />
            ))}
          </div>
        )}
        </div>
      </Panel>
      )}

      {/* Source health */}
      <Panel title="Source health">
        <div className="p-4">
        {sourcesQuery.isError && (
          <ErrorState
            title="Data sources unavailable"
            error={sourcesQuery.error}
            onRetry={() => {
              void sourcesQuery.refetch()
            }}
            retryLabel="Retry"
            compact
          />
        )}
        {!sourcesQuery.isError && sources.length === 0 && (
          <div className="text-body-sm" style={{ color: 'var(--fg-subtle)' }}>
            {sourcesQuery.isLoading ? <LoadingState as="span" /> : 'No data sources connected.'}
          </div>
        )}
        {sources.length > 0 && (
          <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
            {sources.map((source) => (
              <SourceRow key={source.id} source={source} />
            ))}
          </div>
        )}
        </div>
      </Panel>
    </PageContainer>
  )
}


/**
 * The loaded card's shape, held while the series is in flight.
 *
 * The panel is the first content under the KPI strip, and it sat on a bare
 * "Loading…" in an empty box for 2.2 s after the KPI numbers, the 14d sparkline,
 * Top events, Active signals and Recent activity had all rendered — pending, but
 * reading as broken. The blocks match the loaded layout (figure + caption beside
 * a 48px chart that fills the row) so the card reserves its height (tripl-jfjt).
 */
function VolumeSkeleton() {
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
      <div className="flex flex-col gap-1">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-3 w-32" />
      </div>
      <Skeleton className="h-12 min-w-[8rem] flex-1" />
      {/* Skeleton is aria-hidden, so the pending state still needs to be said. */}
      <span role="status" className="sr-only">
        Loading volume…
      </span>
    </div>
  )
}

// Text alternative for the volume sparkline (issue M8): the SVG itself is
// aria-hidden, so the surrounding role="img" needs an accessible summary. Names
// the scan the series is scoped to rather than calling it the project
// total, which it never was (tripl-jfm3.20).
function volumeChartLabel(counts: number[], scanName: string | null): string {
  const scope = scanName ? `Volume sparkline for scan ${scanName}` : 'Volume sparkline'
  if (counts.length === 0) return scope
  const latest = counts[counts.length - 1]!
  const min = Math.min(...counts)
  const max = Math.max(...counts)
  return `${scope}. ${counts.length} buckets. Latest ${formatNumber(latest)}, range ${formatNumber(min)} to ${formatNumber(max)}.`
}

// Text alternative for the new-events trend sparkline (issue #12). Mirrors
// volumeChartLabel: the SVG is decorative, so the wrapping role="img" needs an
// accessible summary of what the 14-day line actually shows. It says "new
// events" because that is what the series counts — announcing it as "active
// events" made the screen-reader text state a falsehood (tripl-jfm3.22).
function newEventsTrendLabel(counts: number[]): string {
  if (counts.length === 0) return 'New events added per day over the last 14 days'
  const latest = counts[counts.length - 1]!
  const min = Math.min(...counts)
  const max = Math.max(...counts)
  return `New events added per day over the last 14 days. Latest ${formatNumber(latest)}, range ${formatNumber(min)} to ${formatNumber(max)}.`
}

function SignalRow({
  slug,
  signal,
}: {
  slug: string
  signal: MonitoringSignal
}) {
  const verb = signal.direction === 'drop' ? 'Drop' : 'Spike'
  const scopeLabel = signalScopeLabel(signal)
  // Full text drives both the visible label and its hover tooltip so a long
  // scope name (e.g. page_value_question_page_value_…) stays readable when the
  // row ellipsizes. When the server could not name the scope the tooltip is
  // where its ref goes — visible, that hex prefix reads as a name and puts a
  // second name on an incident the activity rail already named (tripl-y4wt).
  const signalSummary = `${verb} on ${scopeLabel ?? unnamedScopeLabel(signal)}`
  const signalTitle = `${verb} on ${scopeLabel ?? signalScopeRefLabel(signal)}`
  return (
    <Link
      to={getMonitoringPath(slug, signal)}
      className="flex min-h-(--row-h) items-center gap-2 py-1 no-underline transition-colors hover:bg-[var(--surface-hover)]"
      style={{ color: 'inherit' }}
    >
      <Dot tone={signalDirectionTone(signal.direction)} pulse size={7} />
      <span className="flex-1 truncate text-body-sm font-medium" title={signalTitle}>
        {signalSummary}
      </span>
      <span className="tnum shrink-0 text-caption" style={{ color: 'var(--fg-subtle)' }}>
        {formatSignalValues(signal)}
      </span>
      <span
        className="tnum w-[52px] shrink-0 text-right text-caption"
        style={{ color: signalDirectionColor(signal.direction) }}
      >
        {formatSignalSeverity(signal)}
      </span>
    </Link>
  )
}

const ACTIVITY_ICON: Record<ActivityItemType, LucideIcon> = {
  anomaly: AlertTriangle,
  scan: TrendingUp,
  alert: Bell,
  event: Check,
}

function activitySeverityColor(severity: ActivityItemSeverity): string {
  if (severity === 'high') return 'var(--danger)'
  if (severity === 'medium') return 'var(--warning)'
  return 'var(--fg-muted)'
}

// A failed-scan activity row carries the raw backend exception in `detail`
// (host/port/ORM internals). Surface a friendly, leak-free message instead (H3).
function activityDetail(item: ActivityItem): string {
  if (item.type === 'scan' && item.title.startsWith('Scan failed')) {
    return friendlyScanError(item.detail).message
  }
  return item.detail
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const Icon = ACTIVITY_ICON[item.type]
  const color = activitySeverityColor(item.severity)
  const detail = activityDetail(item)
  const content = (
    <>
      <div
        className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm"
        style={{ background: 'var(--surface)', color: item.severity === 'low' ? 'var(--fg-muted)' : color }}
      >
        <Icon className="h-3 w-3" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body-sm font-medium leading-[1.35]" title={item.title}>{item.title}</div>
        <div className="mt-0.5 truncate text-caption leading-[1.3]" style={{ color: 'var(--fg-subtle)' }}>
          {detail}
        </div>
      </div>
      <span className="tnum shrink-0 text-micro" style={{ color: 'var(--fg-faint)' }}>
        {formatRelativeTime(item.occurred_at)}
      </span>
    </>
  )
  const className =
    'flex min-h-(--row-h) items-start gap-2.5 py-2 no-underline transition-colors hover:bg-[var(--surface-hover)]'
  if (item.target_path) {
    return (
      <Link to={item.target_path} className={className} style={{ color: 'inherit' }}>
        {content}
      </Link>
    )
  }
  return <div className={className}>{content}</div>
}

// A green "healthy" badge over a months-old check is misleading. When the last
// successful test is stale we downgrade the label to "stale" and the recency is
// always made explicit ("checked 2mo ago" + an absolute timestamp tooltip) (M1).
function sourceHealth(source: DataSource, now: number = Date.now()): StatusLexeme {
  const checkedAt = source.last_test_at ? Date.parse(source.last_test_at) : NaN
  const isStale = Number.isNaN(checkedAt) || now - checkedAt > SOURCE_HEALTH_STALE_MS
  return dataSourceHealthLexeme(source.last_test_status, isStale)
}

function SourceRow({ source }: { source: DataSource }) {
  const { tone, label } = sourceHealth(source)
  const checkedLabel = source.last_test_at
    ? `checked ${formatRelativeTime(source.last_test_at)}`
    : 'never checked'
  const checkedTitle = source.last_test_at
    ? `Last checked ${formatDateTime(source.last_test_at)}`
    : 'Never checked'
  // Wraps on a phone. The fixed columns and chips used to take the whole row,
  // leaving the source name ~40px and slicing "checked 1h" off the edge; now
  // the name keeps an 8rem basis, the uppercase type (the badge already says
  // "synthetic") drops below `sm`, and the check time moves to a second line
  // (MON-33, LIVE-20).
  return (
    <div className="flex min-h-(--row-h) flex-wrap items-center gap-x-2 gap-y-0.5 py-2">
      <Dot tone={tone} size={7} />
      <Database className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} />
      <span className="min-w-0 flex-1 basis-32 truncate text-body-sm font-medium" title={source.name}>
        {source.name}
      </span>
      {source.is_synthetic && <SyntheticSourceBadge />}
      <span
        className="mono hidden shrink-0 text-micro sm:inline"
        style={{ color: 'var(--fg-faint)' }}
      >
        {source.db_type}
      </span>
      <span className="w-[64px] shrink-0 text-right text-caption" style={{ color: 'var(--fg-subtle)' }}>
        {label}
      </span>
      <span
        className="ml-auto shrink-0 truncate text-right text-caption sm:ml-0 sm:w-[104px]"
        style={{ color: 'var(--fg-faint)' }}
        title={checkedTitle}
      >
        {checkedLabel}
      </span>
    </div>
  )
}
