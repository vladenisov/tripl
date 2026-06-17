import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Settings2 } from 'lucide-react'
import { alertingApi } from '@/api/alerting'
import { PageHead } from '@/components/settings/kit'
import { ErrorState } from '@/components/error-state'
import { Chip, type ChipTone } from '@/components/primitives/chip'
import { Dot, type DotTone } from '@/components/primitives/dot'
import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import { formatRelativeTime } from '@/lib/datetime'
import type { MonitorStatus, MonitorSummaryItem } from '@/types'

const STATUS_TONE: Record<MonitorStatus, DotTone & ChipTone> = {
  firing: 'danger',
  warning: 'warning',
  healthy: 'success',
}

const STATUS_LABEL: Record<MonitorStatus, string> = {
  firing: 'Firing',
  warning: 'Warning',
  healthy: 'Healthy',
}

export default function MonitorsPage() {
  const { slug } = useParams<{ slug: string }>()

  const monitorsQuery = useQuery({
    queryKey: ['monitors-summary', slug],
    queryFn: () => alertingApi.getMonitorsSummary(slug!),
    enabled: !!slug,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const summary = monitorsQuery.data
  const monitors = summary?.monitors ?? []

  return (
    <div className="min-w-0 space-y-6 pb-12">
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

      {/* Rollup */}
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
      ) : (
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

      {/* Monitors list */}
      <section>
        {monitorsQuery.isLoading && (
          <div className="text-xs" style={{ color: 'var(--fg-subtle)' }}>
            Loading…
          </div>
        )}
        {!monitorsQuery.isLoading && !monitorsQuery.isError && monitors.length === 0 && (
          <div
            className="rounded-md border p-4 text-[12px]"
            style={{
              background: 'var(--surface)',
              borderColor: 'var(--border-subtle)',
              color: 'var(--fg-subtle)',
            }}
          >
            No monitors yet. Monitors are alert rules attached to a destination — create one in{' '}
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
        )}
        {monitors.length > 0 && (
          <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
            {monitors.map((monitor) => (
              <MonitorRow key={monitor.rule_id} monitor={monitor} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function MonitorRow({ monitor }: { monitor: MonitorSummaryItem }) {
  const tone = STATUS_TONE[monitor.status]
  const directions = [
    monitor.notify_on_spike ? 'spike ▲' : null,
    monitor.notify_on_drop ? 'drop ▼' : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const condition = [
    directions,
    monitor.min_percent_delta > 0 ? `≥${monitor.min_percent_delta}%` : null,
    `cooldown ${monitor.cooldown_minutes}m`,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="flex items-center gap-3 py-2.5">
      <Dot tone={tone} pulse={monitor.status === 'firing'} size={8} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12.5px] font-medium">{monitor.rule_name}</span>
          {!monitor.enabled && (
            <Chip tone="neutral" size="xs">
              disabled
            </Chip>
          )}
        </div>
        <div className="mono mt-0.5 truncate text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
          {condition}
        </div>
      </div>
      <div className="hidden flex-col items-end gap-0.5 sm:flex">
        <Chip tone="neutral" size="xs">
          {monitor.destination_type}
        </Chip>
        <span className="truncate text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
          {monitor.destination_name}
        </span>
      </div>
      <div className="flex w-[88px] shrink-0 flex-col items-end gap-0.5">
        <Chip tone={tone} size="xs">
          {STATUS_LABEL[monitor.status]}
        </Chip>
        {monitor.last_anomaly_at && (
          <span className="mono text-[10px]" style={{ color: 'var(--fg-faint)' }}>
            {formatRelativeTime(monitor.last_anomaly_at)}
          </span>
        )}
      </div>
    </div>
  )
}
