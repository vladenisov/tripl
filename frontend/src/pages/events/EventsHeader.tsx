import { Info } from 'lucide-react'

import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { EventType, MonitoringSignal } from '@/types'

// One-line clarifier for the header stat, which reads confusingly next to the
// sidebar "Anomalies" badge on the same screen. The two counts are NOT nested:
// this one comes from the collapsed signals endpoint (incident rollup, no
// magnitude gate) over the series charted here, while the badge counts every
// open signal in the project above the Significant threshold. Either number can
// be the larger one, so the copy must not claim one contains the other.
const CHART_SIGNALS_HELP =
  'Open signals on the series charted here — the project total and event types, after incident rollup. The sidebar Anomalies count is a different measure: every open signal in the project above the Significant threshold. The two can differ in either direction.'

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
        <div className="inline-flex items-center gap-1">
          <MiniStat
            label="Chart signals"
            value={String(liveSignalCount)}
            delta={hasLiveSignal ? 'live' : 'quiet'}
            tone={hasLiveSignal ? 'danger' : 'success'}
            pulse={hasLiveSignal}
          />
          {/* Radix tooltip rather than a bare `title`, so the note opens on
              keyboard focus as well as hover. The icon stays aria-hidden — the
              trigger's label already carries the sentence. The provider is local
              because the header renders outside EventsTable's, and Radix throws
              without one in scope. */}
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex shrink-0 self-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  aria-label={CHART_SIGNALS_HELP}
                >
                  <Info className="h-3 w-3" style={{ color: 'var(--fg-faint)' }} aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end" className="max-w-xs whitespace-normal">
                {CHART_SIGNALS_HELP}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
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
