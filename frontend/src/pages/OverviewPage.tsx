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
import { reconciliationApi } from '@/api/reconciliation'
import { ErrorState } from '@/components/error-state'
import { Dot } from '@/components/primitives/dot'
import { MiniStat, MiniStatDivider, type MiniStatTone } from '@/components/primitives/mini-stat'
import { Sparkline } from '@/components/primitives/sparkline'
import { PageHead, Panel } from '@/components/settings/kit'
import { useTheme } from '@/components/theme-provider'
import { formatRelativeTime } from '@/lib/datetime'
import { getMonitoringPath } from '@/lib/monitoring'
import type {
  ActivityItem,
  ActivityItemSeverity,
  ActivityItemType,
  DataSource,
  MonitoringSignal,
} from '@/types'

const COVERAGE_DAYS = 14
const SIGNAL_LIMIT = 6
const ACTIVITY_LIMIT = 8

export default function OverviewPage() {
  const { slug } = useParams<{ slug: string }>()
  const { chartStyle } = useTheme()

  const projectQuery = useQuery({
    queryKey: ['project', slug],
    queryFn: () => projectsApi.get(slug!),
    enabled: !!slug,
  })
  const coverageQuery = useQuery({
    queryKey: ['reconciliation', 'coverage', slug, COVERAGE_DAYS],
    queryFn: () => reconciliationApi.coverage(slug!, COVERAGE_DAYS),
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
    refetchInterval: 60_000,
  })
  const activityQuery = useQuery({
    queryKey: ['activity', slug ?? 'workspace'],
    queryFn: () => activityApi.list({ slug, limit: ACTIVITY_LIMIT }),
    enabled: !!slug,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
  const sourcesQuery = useQuery({
    queryKey: ['dataSources'],
    queryFn: dataSourcesApi.list,
  })

  const summary = projectQuery.data?.summary
  const coverage = coverageQuery.data?.summary
  const volumePoints = volumeQuery.data?.data ?? []
  const topEvents = topEventsQuery.data ?? []
  const maxTopVolume = topEvents.reduce((m, e) => Math.max(m, e.total_count), 0)
  const signals = signalsQuery.data ?? []
  const activity = activityQuery.data ?? []
  const sources = sourcesQuery.data ?? []

  const signalCount = summary?.monitoring_signal_count ?? signals.length
  const reviewCount = summary?.review_pending_event_count ?? 0
  const coveragePct = coverage?.coverage_pct
  const activeEventsSeries = kpiSeriesQuery.data?.active_events ?? []

  return (
    <div className="min-w-0 space-y-8 pb-12">
      {/* Header */}
      <PageHead eyebrow={projectQuery.data?.name ?? 'Project'} title="Overview" />


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
            value={summary ? signalCount.toLocaleString() : '—'}
            tone={signalCount > 0 ? 'danger' : 'success'}
            pulse={signalCount > 0}
            delta={signalCount > 0 ? 'active' : undefined}
          />
          <MiniStatDivider />
          <MiniStat
            label="Coverage"
            value={coveragePct != null ? `${coveragePct.toFixed(1)}%` : '—'}
            tone={coverageTone(coveragePct)}
          />
          {activeEventsSeries.length > 1 && (
            <>
              <MiniStatDivider />
              <div className="flex items-center gap-2">
                <span
                  className="text-[10px] uppercase tracking-[0.06em]"
                  style={{ color: 'var(--fg-faint)' }}
                >
                  Active · 14d
                </span>
                <Sparkline data={activeEventsSeries} variant={chartStyle} width={120} height={28} />
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
            <div className="flex flex-col gap-px">
              <span className="mono tnum text-2xl font-medium tracking-[-0.01em]">
                {volumePoints[volumePoints.length - 1]!.count.toLocaleString()}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
                latest bucket · {volumePoints.length} buckets
              </span>
            </div>
            <Sparkline
              data={volumePoints.map((p) => p.count)}
              variant={chartStyle}
              width={320}
              height={48}
            />
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
          <div className="space-y-1.5">
            {topEvents.map((e) => (
              <div key={e.event_id} className="flex items-center gap-3">
                <span className="mono w-40 shrink-0 truncate text-[12px]" title={e.name}>
                  {e.name}
                </span>
                <div
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

function coverageTone(pct: number | undefined): MiniStatTone {
  if (pct == null) return 'neutral'
  if (pct >= 90) return 'success'
  if (pct >= 70) return 'warning'
  return 'danger'
}

function signalScopeLabel(signal: MonitoringSignal): string {
  if (signal.scope_type === 'project_total') return 'Project total'
  const ref = signal.scope_ref.slice(0, 8)
  return signal.scope_type === 'event_type' ? `Event type ${ref}` : `Event ${ref}`
}

function SignalRow({ slug, signal }: { slug: string; signal: MonitoringSignal }) {
  return (
    <Link
      to={getMonitoringPath(slug, signal)}
      className="flex items-center gap-2 py-2 no-underline transition-colors hover:bg-[var(--surface-hover)]"
      style={{ color: 'inherit' }}
    >
      <Dot tone={signal.direction === 'drop' ? 'warning' : 'danger'} pulse size={7} />
      <span className="flex-1 truncate text-[12px] font-medium">
        {signal.direction === 'drop' ? 'Drop' : 'Spike'} on {signalScopeLabel(signal)}
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

function ActivityRow({ item }: { item: ActivityItem }) {
  const Icon = ACTIVITY_ICON[item.type]
  const color = activitySeverityColor(item.severity)
  const content = (
    <>
      <div
        className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded"
        style={{ background: 'var(--surface)', color: item.severity === 'low' ? 'var(--fg-muted)' : color }}
      >
        <Icon className="h-3 w-3" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium leading-[1.35]">{item.title}</div>
        <div className="mt-0.5 truncate text-[11px] leading-[1.3]" style={{ color: 'var(--fg-subtle)' }}>
          {item.detail}
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

function sourceTone(status: DataSource['last_test_status']): {
  tone: 'success' | 'danger' | 'neutral'
  label: string
} {
  if (status === 'success') return { tone: 'success', label: 'healthy' }
  if (status === 'failed') return { tone: 'danger', label: 'failing' }
  return { tone: 'neutral', label: 'untested' }
}

function SourceRow({ source }: { source: DataSource }) {
  const { tone, label } = sourceTone(source.last_test_status)
  return (
    <div className="flex items-center gap-2 py-2">
      <Dot tone={tone} size={7} />
      <Database className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} />
      <span className="flex-1 truncate text-[12px] font-medium">{source.name}</span>
      <span className="mono shrink-0 text-[10.5px] uppercase" style={{ color: 'var(--fg-faint)' }}>
        {source.db_type}
      </span>
      <span className="w-[64px] shrink-0 text-right text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
        {label}
      </span>
      <span className="w-[64px] shrink-0 text-right text-[11px]" style={{ color: 'var(--fg-faint)' }}>
        {source.last_test_at ? formatRelativeTime(source.last_test_at) : '—'}
      </span>
    </div>
  )
}
