import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Activity, AlertTriangle, ArrowRight, Settings2 } from 'lucide-react'
import { alertingApi } from '@/api/alerting'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { PageHead, Panel } from '@/components/settings/kit'
import { ErrorState } from '@/components/error-state'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import { formatRelativeTime } from '@/lib/datetime'
import {
  MONITOR_STATUS_LABEL as STATUS_LABEL,
  MONITOR_STATUS_TONE as STATUS_TONE,
} from '@/lib/statusLexicon'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import { formatCooldown } from './alerting/constants'
import type { MonitorSummaryItem } from '@/types'

const MONITOR_GRID = 'grid grid-cols-[1.4fr_1.6fr_1fr_84px_84px] items-center gap-3 px-4'

export default function MonitorsPage() {
  const { slug } = useParams<{ slug: string }>()
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })

  const monitorsQuery = useQuery({
    queryKey: ['monitors-summary', slug],
    queryFn: () => alertingApi.getMonitorsSummary(slug!),
    enabled: !!slug,
    refetchInterval,
    staleTime: 30_000,
  })

  const summary = monitorsQuery.data
  const monitors = summary?.monitors ?? []
  // The summary has loaded but the project has no monitors at all. This is
  // distinct from loading (no summary yet) and from the error state, both of
  // which keep the normal rollup + panel layout.
  const isEmpty = !monitorsQuery.isError && !!summary && monitors.length === 0

  return (
    <div
      className={
        isEmpty
          ? 'flex min-h-[calc(100vh-7rem)] min-w-0 flex-col gap-6'
          : 'min-w-0 space-y-6 pb-12'
      }
    >
      {/* Header */}
      <PageHead
        eyebrow="Observe"
        title="Monitors"
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

      {/* Firing banner */}
      {summary && summary.firing_count > 0 && (
        <div
          className="flex items-center gap-2.5 rounded-[10px] px-4 py-3"
          style={{
            background: 'var(--danger-soft)',
            border: '1px solid color-mix(in oklab, var(--danger) 35%, var(--border))',
          }}
        >
          <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: 'var(--danger)' }} />
          <span className="text-[12.5px]" style={{ color: 'var(--fg-muted)' }}>
            <span className="font-semibold" style={{ color: 'var(--fg)' }}>
              {summary.firing_count}
            </span>{' '}
            monitor{summary.firing_count === 1 ? '' : 's'} firing right now.
          </span>
        </div>
      )}

      {/* Rollup — hidden entirely when the project has no monitors, so an
          all-zero FIRING/WARNING/HEALTHY/MONITORS row never sits above the
          empty state. */}
      {monitorsQuery.isError ? (
        <ErrorState
          title="Monitors unavailable"
          error={monitorsQuery.error}
          onRetry={() => {
            void monitorsQuery.refetch()
          }}
          retryLabel="Retry"
          compact
        />
      ) : isEmpty ? null : (
        <div
          className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-lg border px-4 py-3"
          style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)' }}
        >
          <MiniStat
            label="Firing"
            value={summary ? summary.firing_count.toLocaleString() : '—'}
            tone={summary && summary.firing_count > 0 ? 'danger' : 'neutral'}
            pulse={!!summary && summary.firing_count > 0}
            delta={summary && summary.firing_count > 0 ? 'now' : undefined}
          />
          <MiniStatDivider />
          <MiniStat
            label="Warning"
            value={summary ? summary.warning_count.toLocaleString() : '—'}
            tone={summary && summary.warning_count > 0 ? 'warning' : 'neutral'}
          />
          <MiniStatDivider />
          <MiniStat
            label="Healthy"
            value={summary ? summary.healthy_count.toLocaleString() : '—'}
            tone="success"
          />
          <MiniStatDivider />
          <MiniStat label="Monitors" value={summary ? summary.total.toLocaleString() : '—'} />
        </div>
      )}

      {/* Monitors table — or a centered empty state when the project has none */}
      {!monitorsQuery.isError &&
        (isEmpty ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={Activity}
              title="No monitors yet"
              description="tripl already watches every event's rhythm and raises signals on spikes and drops. A monitor is an alert rule that decides which signals matter and where they go — create one to start routing them."
              action={
                slug ? (
                  <Button asChild size="sm">
                    <Link to={`/p/${slug}/settings/alerting`} className="no-underline">
                      Alerting settings
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <Panel title="Monitors" subtitle={summary ? `${summary.total} total` : undefined}>
          {monitorsQuery.isLoading ? (
            <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
              Loading…
            </div>
          ) : monitors.length === 0 ? (
            <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
              No monitors yet. Detection already raises signals on spikes and drops; a monitor decides which signals matter and where they go — create one in{' '}
              {slug ? (
                <Link
                  to={`/p/${slug}/settings/alerting`}
                  className="font-medium text-primary hover:underline"
                >
                  Alerting settings
                </Link>
              ) : (
                'Alerting settings'
              )}
              .
            </div>
          ) : (
            // Below the grid's min-width the fixed columns would squish, so it
            // scrolls horizontally on small screens; lg+ is unchanged (the
            // min-width sits under the available width).
            <div className="overflow-x-auto">
              <div role="table" aria-label="Monitors" className="min-w-[680px]">
                <div role="rowgroup">
                  <div
                    role="row"
                    className={`${MONITOR_GRID} border-b py-2 text-[10.5px] font-semibold uppercase tracking-[0.05em]`}
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--fg-faint)' }}
                  >
                    <span role="columnheader">Monitor</span>
                    <span role="columnheader">Condition</span>
                    <span role="columnheader">Routes to</span>
                    <span role="columnheader">State</span>
                    <span role="columnheader" className="text-right">Last fired</span>
                  </div>
                </div>
                <div role="rowgroup">
                  {monitors.map((monitor) => (
                    <MonitorRow key={monitor.rule_id} monitor={monitor} slug={slug} />
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

function MonitorRow({ monitor, slug }: { monitor: MonitorSummaryItem; slug?: string }) {
  const navigate = useNavigate()
  const tone = STATUS_TONE[monitor.status]
  const href = slug ? `/p/${slug}/monitors/${monitor.rule_id}` : undefined
  const directions = [
    monitor.notify_on_spike ? 'spike ▲' : null,
    monitor.notify_on_drop ? 'drop ▼' : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const condition = [
    directions,
    monitor.min_percent_delta > 0 ? `≥${monitor.min_percent_delta}%` : null,
    // Same shared formatter the alerting destinations card uses, so one rule
    // reads as one duration on every screen instead of "360m" here and "6h"
    // there (tripl-oxkt.18).
    `cooldown ${formatCooldown(monitor.cooldown_minutes)}`,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      role="row"
      tabIndex={href ? 0 : undefined}
      className={`${MONITOR_GRID} border-b py-2.5 last:border-0 ${
        href ? 'cursor-pointer transition-colors hover:bg-[var(--surface-hover)]' : 'cursor-default'
      }`}
      style={{ borderColor: 'var(--border-subtle)' }}
      onClick={href ? () => navigate(href) : undefined}
      onKeyDown={
        href
          ? (event) => {
              if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault()
                navigate(href)
              }
            }
          : undefined
      }
    >
      <span role="cell" className="flex min-w-0 items-center gap-2">
        <Dot tone={tone} pulse={monitor.status === 'firing'} size={7} />
        {href ? (
          <Link
            to={href}
            onClick={(event) => event.stopPropagation()}
            className="truncate text-[12.5px] font-medium no-underline hover:underline"
            style={{ color: 'var(--fg)' }}
          >
            {monitor.rule_name}
          </Link>
        ) : (
          <span className="truncate text-[12.5px] font-medium">{monitor.rule_name}</span>
        )}
        {!monitor.enabled && (
          <Chip tone="neutral" size="xs">
            off
          </Chip>
        )}
        {monitor.muted && (
          <Chip tone="warning" size="xs">
            muted
          </Chip>
        )}
      </span>
      <span role="cell" className="mono truncate text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
        {condition}
      </span>
      <span role="cell" className="flex min-w-0 flex-col gap-0.5">
        <Chip tone="neutral" size="xs">
          {monitor.destination_type}
        </Chip>
        <span
          className="truncate text-[10px]"
          style={{ color: 'var(--fg-faint)' }}
          title={`Routes to the "${monitor.destination_name}" ${monitor.destination_type} destination`}
        >
          {monitor.destination_name}
        </span>
      </span>
      <span role="cell">
        <Chip tone={tone} size="xs">
          {STATUS_LABEL[monitor.status]}
        </Chip>
      </span>
      <span role="cell" className="mono text-right text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
        {monitor.last_anomaly_at ? formatRelativeTime(monitor.last_anomaly_at) : '—'}
      </span>
    </div>
  )
}
