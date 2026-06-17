import { useQuery } from '@tanstack/react-query'
import { alertingApi } from '@/api/alerting'
import { Chip, type ChipTone } from '@/components/primitives/chip'
import { Dot, type DotTone } from '@/components/primitives/dot'
import { Panel } from '@/components/settings/kit'
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

const GRID = 'grid grid-cols-[1.4fr_1.6fr_1fr_84px_72px] items-center gap-3 px-4'

function conditionOf(m: MonitorSummaryItem): string {
  const directions = [
    m.notify_on_spike ? 'spike ▲' : null,
    m.notify_on_drop ? 'drop ▼' : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return [
    directions,
    m.min_percent_delta > 0 ? `≥${m.min_percent_delta}%` : null,
    `cooldown ${m.cooldown_minutes}m`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The mockup's central Alerting artifact: a flat monitor → destination routing
 * matrix. Built entirely on the existing monitors-summary endpoint (rule →
 * single destination), so it's a presentation layer over data we already have.
 */
export function RoutingRulesPanel({ slug }: { slug: string }) {
  const query = useQuery({
    queryKey: ['monitors-summary', slug],
    queryFn: () => alertingApi.getMonitorsSummary(slug),
    enabled: !!slug,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const summary = query.data
  const monitors = summary?.monitors ?? []
  const subtitle = summary
    ? `${summary.total} monitor${summary.total === 1 ? '' : 's'} · ${summary.firing_count} firing`
    : undefined

  return (
    <Panel
      title="Routing rules"
      subtitle={subtitle}
      subtitleTone={summary && summary.firing_count > 0 ? 'danger' : undefined}
    >
      {monitors.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
          {query.isLoading ? 'Loading…' : 'No monitors route to a destination yet.'}
        </div>
      ) : (
        <div>
          <div
            className={`${GRID} border-b py-2 text-[10.5px] font-semibold uppercase tracking-[0.05em]`}
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--fg-faint)' }}
          >
            <span>Monitor</span>
            <span>Condition</span>
            <span>Routes to</span>
            <span>State</span>
            <span className="text-right">Last fired</span>
          </div>
          {monitors.map((m) => (
            <div
              key={m.rule_id}
              className={`${GRID} border-b py-2.5 last:border-0`}
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Dot tone={STATUS_TONE[m.status]} pulse={m.status === 'firing'} size={7} />
                <span className="truncate text-[12.5px] font-medium">{m.rule_name}</span>
                {!m.enabled && (
                  <Chip tone="neutral" size="xs">
                    off
                  </Chip>
                )}
              </span>
              <span className="mono truncate text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
                {conditionOf(m)}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <Chip tone="neutral" size="xs">
                  {m.destination_type}
                </Chip>
                <span className="truncate text-[10px]" style={{ color: 'var(--fg-faint)' }}>
                  {m.destination_name}
                </span>
              </span>
              <span>
                <Chip tone={STATUS_TONE[m.status]} size="xs">
                  {STATUS_LABEL[m.status]}
                </Chip>
              </span>
              <span className="mono text-right text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
                {m.last_anomaly_at ? formatRelativeTime(m.last_anomaly_at) : '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
