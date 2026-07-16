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
import { dataSourcesApi } from '@/api/dataSources'
import { metricsApi } from '@/api/metrics'
import { projectsApi } from '@/api/projects'
import { ErrorState } from '@/components/error-state'
import { OnboardingChecklist } from '@/components/onboarding-checklist'
import { countRealSources } from '@/components/onboarding-utils'
import { SyntheticSourceBadge } from '@/demo/capabilityBadges'
import { DemoWelcomePanel } from '@/demo/DemoWelcomePanel'
import { Dot } from '@/components/primitives/dot'
import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import { Sparkline } from '@/components/primitives/sparkline'
import { PageHead, Panel } from '@/components/settings/kit'
import { useTheme } from '@/components/theme-provider'
import { formatPlanCoverage, planCoverageRatio } from '@/lib/coverage'
import { coverageTone, dataSourceHealthLexeme, type StatusLexeme } from '@/lib/statusLexicon'
import { formatDateTime, formatRelativeTime } from '@/lib/datetime'
import { getMonitoringPath } from '@/lib/monitoring'
import { friendlyScanError } from '@/lib/scanError'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import type {
  ActivityItem,
  ActivityItemSeverity,
  ActivityItemType,
  DataSource,
  MonitoringSignal,
} from '@/types'

const SIGNAL_LIMIT = 6
const ACTIVITY_LIMIT = 8
// A successful source connection test older than this is shown as "stale" rather
// than a confident "healthy" — an old green check is misleading (issue M1).
const SOURCE_HEALTH_STALE_MS = 24 * 60 * 60 * 1000

export default function OverviewPage() {
  const { slug } = useParams<{ slug: string }>()
  const { chartStyle } = useTheme()
  // Adaptive fallback cadence: the live stream refreshes signals/activity via the
  // invalidation map, so poll only while the stream is unavailable.
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })

  const projectQuery = useQuery({
    queryKey: ['project', slug],
    queryFn: () => projectsApi.get(slug!),
    enabled: !!slug,
  })
  const volumeQuery = useQuery({
    queryKey: ['overview', 'volume', slug],
    queryFn: () => metricsApi.getProjectTotalMetrics(slug!),
    enabled: !!slug,
    staleTime: 60_000,
  })
  const topEventsQuery = useQuery({
    queryKey: ['overview', 'top-events', slug],
    queryFn: () => metricsApi.getTopEvents(slug!, { windowHours: 48, limit: 6 }),
    enabled: !!slug,
    staleTime: 60_000,
  })
  const kpiSeriesQuery = useQuery({
    queryKey: ['overview', 'kpi-series', slug],
    queryFn: () => metricsApi.getOverviewKpiSeries(slug!, 14),
    enabled: !!slug,
    staleTime: 60_000,
  })
  const signalsQuery = useQuery({
    queryKey: ['overview', 'signals', slug],
    queryFn: () => metricsApi.getActiveSignals(slug!),
    enabled: !!slug,
    staleTime: 30_000,
    refetchInterval,
  })
  const activityQuery = useQuery({
    queryKey: ['activity', slug ?? 'workspace'],
    queryFn: () => activityApi.list({ slug, limit: ACTIVITY_LIMIT }),
    enabled: !!slug,
    staleTime: 30_000,
    refetchInterval,
  })
  const sourcesQuery = useQuery({
    queryKey: ['dataSources'],
    queryFn: dataSourcesApi.list,
  })

  const summary = projectQuery.data?.summary
  const volumePoints = volumeQuery.data?.data ?? []
  const volumeCounts = volumePoints.map((p) => p.count)
  const topEvents = topEventsQuery.data ?? []
  const maxTopVolume = topEvents.reduce((m, e) => Math.max(m, e.total_count), 0)
  const signals = signalsQuery.data ?? []
  const activity = activityQuery.data ?? []
  const sources = sourcesQuery.data ?? []

  // "Open signals" must come from the SAME array the panel below renders, so the
  // headline can never disagree with the list (issue H1).
  const signalCount = signals.length
  const reviewCount = summary?.review_pending_event_count ?? 0
  // Coverage is plan coverage (implemented vs active events) rendered through the
  // canonical formatter, so it reads identically to the projects dashboard (H2).
  const coveragePct = summary
    ? planCoverageRatio(summary.implemented_event_count, summary.active_event_count) * 100
    : undefined
  const activeEventsSeries = kpiSeriesQuery.data?.active_events ?? []

  return (
    <div className="min-w-0 space-y-8 pb-12">
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
          summary={summary}
          sourceCount={countRealSources(sources)}
          isDemo={projectQuery.data?.is_demo}
        />
      )}

      {/* Header */}
      <PageHead eyebrow={projectQuery.data?.name ?? 'Project'} title="Live activity" />


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
        <div
          className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-lg border px-4 py-3"
          style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)' }}
        >
          <MiniStat
            label="Active events"
            value={summary ? summary.active_event_count.toLocaleString() : '—'}
          />
          <MiniStatDivider />
          <MiniStat
            label="Implemented"
            value={summary ? summary.implemented_event_count.toLocaleString() : '—'}
            tone="success"
          />
          <MiniStatDivider />
          <MiniStat
            label="Needs review"
            value={summary ? reviewCount.toLocaleString() : '—'}
            tone={reviewCount > 0 ? 'warning' : 'neutral'}
          />
          <MiniStatDivider />
          <MiniStat
            label="Open signals"
            value={signalsQuery.data ? signalCount.toLocaleString() : '—'}
            tone={signalCount > 0 ? 'danger' : 'success'}
            pulse={signalCount > 0}
            delta={signalCount > 0 ? 'active' : undefined}
          />
          <MiniStatDivider />
          <MiniStat
            label="Coverage"
            value={
              summary
                ? formatPlanCoverage(summary.implemented_event_count, summary.active_event_count)
                : '—'
            }
            tone={coverageTone(coveragePct)}
          />
          {activeEventsSeries.length > 1 && (
            <>
              <MiniStatDivider />
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
                title="Active events over the last 14 days"
              >
                <span
                  className="text-[10px] font-semibold uppercase tracking-[0.06em]"
                  style={{ color: 'var(--fg-faint)' }}
                >
                  Active trend · 14d
                </span>
                <div role="img" aria-label={activeTrendLabel(activeEventsSeries)}>
                  <Sparkline
                    data={activeEventsSeries}
                    variant={chartStyle}
                    width={120}
                    height={24}
                  />
                  <span className="sr-only">
                    Active events by day: {activeEventsSeries.map((c) => c.toLocaleString()).join(', ')}.
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Volume */}
      <Panel title="Volume · project total">
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
        {!volumeQuery.isError && volumePoints.length === 0 && (
          <div className="text-xs" style={{ color: 'var(--fg-subtle)' }}>
            {volumeQuery.isLoading ? 'Loading…' : 'No volume data yet.'}
          </div>
        )}
        {volumePoints.length > 0 && (
          <div className="flex items-end gap-4">
            <div
              role="group"
              aria-label={`Latest bucket volume ${volumeCounts[volumeCounts.length - 1]!.toLocaleString()}, ${volumePoints.length} buckets`}
              className="flex flex-col gap-px"
            >
              <span className="mono tnum text-2xl font-medium tracking-[-0.01em]">
                {volumeCounts[volumeCounts.length - 1]!.toLocaleString()}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
                latest bucket · {volumePoints.length} buckets
              </span>
            </div>
            <div role="img" aria-label={volumeChartLabel(volumeCounts)}>
              <Sparkline data={volumeCounts} variant={chartStyle} width={320} height={48} />
              <span className="sr-only">
                Volume by bucket: {volumeCounts.map((c) => c.toLocaleString()).join(', ')}.
              </span>
            </div>
          </div>
        )}
        </div>
      </Panel>

      {/* Top events by volume */}
      <Panel title="Top events · 48h">
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
          <div className="text-xs" style={{ color: 'var(--fg-subtle)' }}>
            {topEventsQuery.isLoading ? 'Loading…' : 'No event volume in the last 48 hours.'}
          </div>
        )}
        {topEvents.length > 0 && (
          <div role="list" aria-label="Top events by volume, last 48 hours" className="space-y-1.5">
            {topEvents.map((e) => (
              <div
                key={e.event_id}
                role="listitem"
                aria-label={`${e.name}: ${e.total_count.toLocaleString()} events`}
                className="flex items-center gap-3"
              >
                <span className="mono w-40 shrink-0 truncate text-[12px]" title={e.name}>
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
                      background: 'var(--accent)',
                    }}
                  />
                </div>
                <span
                  className="mono tnum w-16 shrink-0 text-right text-[11px]"
                  style={{ color: 'var(--fg-subtle)' }}
                >
                  {e.total_count.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
        </div>
      </Panel>

      {/* Active signals */}
      <Panel title="Active signals">
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
          <div className="text-xs" style={{ color: 'var(--fg-subtle)' }}>
            {signalsQuery.isLoading ? 'Loading…' : 'No active monitoring signals.'}
          </div>
        )}
        {signals.length > 0 && slug && (
          <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
            {signals.slice(0, SIGNAL_LIMIT).map((signal) => (
              <SignalRow key={`${signal.scope_type}:${signal.scope_ref}`} slug={slug} signal={signal} />
            ))}
          </div>
        )}
        </div>
      </Panel>

      {/* Recent activity */}
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
          <div className="text-xs" style={{ color: 'var(--fg-subtle)' }}>
            {activityQuery.isLoading ? 'Loading…' : 'No recent activity.'}
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
          <div className="text-xs" style={{ color: 'var(--fg-subtle)' }}>
            {sourcesQuery.isLoading ? 'Loading…' : 'No data sources connected.'}
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
    </div>
  )
}


// Text alternative for the volume sparkline (issue M8): the SVG itself is
// aria-hidden, so the surrounding role="img" needs an accessible summary.
function volumeChartLabel(counts: number[]): string {
  if (counts.length === 0) return 'Project total volume sparkline'
  const latest = counts[counts.length - 1]!
  const min = Math.min(...counts)
  const max = Math.max(...counts)
  return `Project total volume sparkline. ${counts.length} buckets. Latest ${latest.toLocaleString()}, range ${min.toLocaleString()} to ${max.toLocaleString()}.`
}

// Text alternative for the active-events trend sparkline (issue #12). Mirrors
// volumeChartLabel: the SVG is decorative, so the wrapping role="img" needs an
// accessible summary of what the 14-day line actually shows.
function activeTrendLabel(counts: number[]): string {
  if (counts.length === 0) return 'Active events over the last 14 days'
  const latest = counts[counts.length - 1]!
  const min = Math.min(...counts)
  const max = Math.max(...counts)
  return `Active events over the last 14 days. Latest ${latest.toLocaleString()}, range ${min.toLocaleString()} to ${max.toLocaleString()}.`
}

function signalScopeLabel(signal: MonitoringSignal): string {
  if (signal.scope_type === 'project_total') return 'Project total'
  const ref = signal.scope_ref.slice(0, 8)
  return signal.scope_type === 'event_type' ? `Event type ${ref}` : `Event ${ref}`
}

function SignalRow({ slug, signal }: { slug: string; signal: MonitoringSignal }) {
  // Full text drives both the visible label and its hover tooltip so a long
  // scope name (e.g. page_value_question_page_value_…) stays readable when the
  // row ellipsizes.
  const signalSummary = `${signal.direction === 'drop' ? 'Drop' : 'Spike'} on ${signalScopeLabel(signal)}`
  return (
    <Link
      to={getMonitoringPath(slug, signal)}
      className="flex items-center gap-2 py-2 no-underline transition-colors hover:bg-[var(--surface-hover)]"
      style={{ color: 'inherit' }}
    >
      <Dot tone={signal.direction === 'drop' ? 'warning' : 'danger'} pulse size={7} />
      <span className="flex-1 truncate text-[12px] font-medium" title={signalSummary}>
        {signalSummary}
      </span>
      <span className="mono shrink-0 text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
        {signal.actual_count.toLocaleString()} vs {Math.round(signal.expected_count).toLocaleString()}
      </span>
      <span
        className="mono w-[52px] shrink-0 text-right text-[11px]"
        style={{ color: signal.direction === 'drop' ? 'var(--warning)' : 'var(--danger)' }}
      >
        z={signal.z_score.toFixed(1)}
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
        className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded"
        style={{ background: 'var(--surface)', color: item.severity === 'low' ? 'var(--fg-muted)' : color }}
      >
        <Icon className="h-3 w-3" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium leading-[1.35]" title={item.title}>{item.title}</div>
        <div className="mt-0.5 truncate text-[11px] leading-[1.3]" style={{ color: 'var(--fg-subtle)' }}>
          {detail}
        </div>
      </div>
      <span className="mono shrink-0 text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
        {formatRelativeTime(item.occurred_at)}
      </span>
    </>
  )
  const className =
    'flex items-start gap-2.5 py-2 no-underline transition-colors hover:bg-[var(--surface-hover)]'
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
  return (
    <div className="flex items-center gap-2 py-2">
      <Dot tone={tone} size={7} />
      <Database className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} />
      <span className="flex-1 truncate text-[12px] font-medium" title={source.name}>{source.name}</span>
      {source.is_synthetic && <SyntheticSourceBadge />}
      <span className="mono shrink-0 text-[10.5px] uppercase" style={{ color: 'var(--fg-faint)' }}>
        {source.db_type}
      </span>
      <span className="w-[64px] shrink-0 text-right text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
        {label}
      </span>
      <span
        className="w-[104px] shrink-0 truncate text-right text-[11px]"
        style={{ color: 'var(--fg-faint)' }}
        title={checkedTitle}
      >
        {checkedLabel}
      </span>
    </div>
  )
}
