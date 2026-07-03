import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Activity, ArrowDown, ArrowUp, Settings2 } from 'lucide-react'
import { metricsApi } from '@/api/metrics'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { PageHead, Panel } from '@/components/settings/kit'
import { Dot } from '@/components/primitives/dot'
import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import { formatRelativeTime } from '@/lib/datetime'
import { getMonitoringPath } from '@/lib/monitoring'
import type { MonitoringSignal } from '@/types'

const ANOMALY_GRID = 'grid grid-cols-[1.7fr_1fr_72px_96px] items-center gap-3 px-4'

/** Metric definition id → catalog display name, for labelling metric signals. */
type MetricNameMap = ReadonlyMap<string, string>

// The four scopes that have a monitoring detail route (metric scope_ref is the
// metric definition id, routed via getMetricMonitoringPath); getMonitoringPath
// throws for the rest, so non-linkable signals render as a plain (unlinked) row.
function isLinkableScope(signal: MonitoringSignal): boolean {
  return (
    signal.scope_type === 'project_total'
    || signal.scope_type === 'event_type'
    || signal.scope_type === 'event'
    || signal.scope_type === 'metric'
  )
}

function signalScopeLabel(signal: MonitoringSignal, metricNames: MetricNameMap): string {
  if (signal.scope_type === 'project_total') return 'Project total'
  const ref = signal.scope_ref.slice(0, 8)
  if (signal.scope_type === 'event_type') return `Event type ${ref}`
  if (signal.scope_type === 'event') return `Event ${ref}`
  if (signal.scope_type === 'metric') {
    // Resolved from the metrics catalog; fall back to the short ref while the
    // catalog loads or when the definition is gone (e.g. deleted metric).
    const name = metricNames.get(signal.scope_ref)
    return name ? `Metric · ${name}` : `Metric ${ref}`
  }
  return `${signal.scope_type} ${ref}`
}

export default function AnomaliesPage() {
  const { slug } = useParams<{ slug: string }>()

  const signalsQuery = useQuery({
    queryKey: ['anomalies', 'signals', slug],
    queryFn: () => metricsApi.getActiveSignals(slug!),
    enabled: !!slug,
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  // Metric-scope signals only carry the definition id; the catalog list
  // resolves it to a display name. Shares the 'metrics-catalog' key prefix so
  // catalog mutations invalidate this copy too. Purely additive — a failed or
  // pending fetch just leaves the short-ref fallback label.
  const metricsCatalogQuery = useQuery({
    queryKey: ['metrics-catalog', slug, 'names'],
    queryFn: () => metricsCatalogApi.list(slug!),
    enabled: !!slug,
    staleTime: 60_000,
  })
  const metricNames: MetricNameMap = new Map(
    (metricsCatalogQuery.data?.items ?? []).map((m) => [m.id, m.display_name]),
  )

  const signals = signalsQuery.data ?? []
  // Most severe first: the largest |z| is the most extreme deviation.
  const sorted = [...signals].sort((a, b) => Math.abs(b.z_score) - Math.abs(a.z_score))
  const spikes = signals.filter((s) => s.direction === 'spike').length
  const drops = signals.filter((s) => s.direction === 'drop').length
  // Loaded with nothing open — distinct from loading and from the error state.
  const isEmpty = !signalsQuery.isError && !!signalsQuery.data && signals.length === 0

  return (
    <div
      className={
        isEmpty
          ? 'flex min-h-[calc(100vh-7rem)] min-w-0 flex-col gap-6'
          : 'min-w-0 space-y-6 pb-12'
      }
    >
      <PageHead
        eyebrow="Observe"
        title="Anomalies"
        right={
          slug ? (
            <Link
              to={`/p/${slug}/settings/monitoring`}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] no-underline transition-colors hover:bg-[var(--surface-hover)]"
              style={{ color: 'var(--fg-muted)' }}
            >
              <Settings2 className="h-3.5 w-3.5" />
              Detection settings
            </Link>
          ) : undefined
        }
      />

      {/* Rollup */}
      {signalsQuery.isError ? (
        <ErrorState
          title="Anomalies unavailable"
          error={signalsQuery.error}
          onRetry={() => {
            void signalsQuery.refetch()
          }}
          retryLabel="Retry"
          compact
        />
      ) : (
        <div
          className={`flex flex-wrap items-center gap-x-6 gap-y-4 rounded-lg border px-4 py-3 ${
            isEmpty ? 'opacity-60' : ''
          }`}
          style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)' }}
        >
          <MiniStat
            label="Open signals"
            value={signalsQuery.data ? signals.length.toLocaleString() : '—'}
            tone={signals.length > 0 ? 'danger' : 'success'}
            pulse={signals.length > 0}
            delta={signals.length > 0 ? 'active' : undefined}
          />
          <MiniStatDivider />
          <MiniStat
            label="Spikes"
            value={signalsQuery.data ? spikes.toLocaleString() : '—'}
            tone={spikes > 0 ? 'danger' : 'neutral'}
          />
          <MiniStatDivider />
          <MiniStat
            label="Drops"
            value={signalsQuery.data ? drops.toLocaleString() : '—'}
            tone={drops > 0 ? 'warning' : 'neutral'}
          />
        </div>
      )}

      {/* Signals table — or a centered empty state when nothing is firing */}
      {!signalsQuery.isError &&
        (isEmpty ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={Activity}
              title="No anomalies right now"
              description="When detection flags a spike or drop against the learned baseline, it shows up here. Tune sensitivity in detection settings."
            />
          </div>
        ) : (
          <Panel
            title="Active signals"
            subtitle={signalsQuery.data ? `${signals.length} open` : undefined}
          >
            {signalsQuery.isLoading ? (
              <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                Loading…
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div role="table" aria-label="Anomaly signals" className="min-w-[640px]">
                  <div role="rowgroup">
                    <div
                      role="row"
                      className={`${ANOMALY_GRID} border-b py-2 text-[10.5px] font-semibold uppercase tracking-[0.05em]`}
                      style={{ borderColor: 'var(--border-subtle)', color: 'var(--fg-faint)' }}
                    >
                      <span role="columnheader">Anomaly</span>
                      <span role="columnheader">Actual vs expected</span>
                      <span role="columnheader" className="text-right">Severity</span>
                      <span role="columnheader" className="text-right">When</span>
                    </div>
                  </div>
                  <div role="rowgroup">
                    {sorted.map((signal) => (
                      <AnomalyRow
                        key={`${signal.scope_type}:${signal.scope_ref}:${signal.bucket}`}
                        slug={slug}
                        signal={signal}
                        metricNames={metricNames}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </Panel>
        ))}
    </div>
  )
}

function AnomalyRow({
  slug,
  signal,
  metricNames,
}: {
  slug?: string
  signal: MonitoringSignal
  metricNames: MetricNameMap
}) {
  const navigate = useNavigate()
  const isDrop = signal.direction === 'drop'
  const DirIcon = isDrop ? ArrowDown : ArrowUp
  const severityColor = isDrop ? 'var(--warning)' : 'var(--danger)'
  const href = slug && isLinkableScope(signal) ? getMonitoringPath(slug, signal) : undefined

  return (
    <div
      role="row"
      tabIndex={href ? 0 : undefined}
      className={`${ANOMALY_GRID} border-b py-2.5 last:border-0 ${
        href ? 'cursor-pointer transition-colors hover:bg-[var(--surface-hover)]' : 'cursor-default'
      }`}
      style={{ borderColor: 'var(--border-subtle)' }}
      onClick={href ? () => navigate(href) : undefined}
      onKeyDown={
        href
          ? (event) => {
              if (
                event.target === event.currentTarget
                && (event.key === 'Enter' || event.key === ' ')
              ) {
                event.preventDefault()
                navigate(href)
              }
            }
          : undefined
      }
    >
      <span role="cell" className="flex min-w-0 items-center gap-2">
        <Dot tone={isDrop ? 'warning' : 'danger'} pulse size={7} />
        <DirIcon className="h-3.5 w-3.5 shrink-0" style={{ color: severityColor }} />
        <span className="truncate text-[12.5px] font-medium" style={{ color: 'var(--fg)' }}>
          {isDrop ? 'Drop' : 'Spike'} on {signalScopeLabel(signal, metricNames)}
        </span>
      </span>
      <span role="cell" className="mono truncate text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
        {signal.actual_count.toLocaleString()} vs {Math.round(signal.expected_count).toLocaleString()}
      </span>
      <span role="cell" className="mono text-right text-[11px]" style={{ color: severityColor }}>
        z={signal.z_score.toFixed(1)}
      </span>
      <span role="cell" className="mono text-right text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
        {formatRelativeTime(signal.bucket)}
      </span>
    </div>
  )
}
