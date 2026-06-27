import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import type { EventType, MonitoringSignal } from '@/types'

export function EventsHeader({
  total,
  unreviewedCount,
  projectTotalSignal,
  eventTypeSignals,
  activeType = null,
}: {
  total: number
  unreviewedCount: number
  projectTotalSignal: MonitoringSignal | null
  eventTypeSignals: Map<string, MonitoringSignal>
  // When a type tab is active (e.g. /events/pv) the heading reflects it
  // ("Page View events") instead of the generic "Events".
  activeType?: EventType | null
}) {
  const liveSignalCount = eventTypeSignals.size + (projectTotalSignal ? 1 : 0)
  const hasLiveSignal = eventTypeSignals.size > 0 || !!projectTotalSignal

  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-4">
      <div className="flex items-baseline gap-2.5">
        <h1 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">
          {activeType ? `${activeType.display_name} events` : 'Events'}
        </h1>
        <span className="mono text-[13px]" style={{ color: 'var(--fg-subtle)' }}>{total}</span>
      </div>
      <div className="flex items-center gap-4">
        <MiniStat label="Total" value={String(total)} />
        <MiniStatDivider />
        <MiniStat
          label="Active signals"
          value={String(liveSignalCount)}
          delta={hasLiveSignal ? 'live' : 'quiet'}
          tone={hasLiveSignal ? 'danger' : 'success'}
          pulse={hasLiveSignal}
        />
        <MiniStatDivider />
        <MiniStat
          label="Review"
          value={String(unreviewedCount)}
          delta={unreviewedCount > 0 ? 'pending' : undefined}
          tone={unreviewedCount > 0 ? 'warning' : 'success'}
        />
      </div>
    </div>
  )
}
