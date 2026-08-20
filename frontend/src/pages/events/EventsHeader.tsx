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

// The one stat in this row that does NOT follow the tab, filters or search: it
// is a separate project-wide query (useEventsPageData `inReviewCount`), while
// "Total" beside it is the filtered list count. Unlabelled, the row read as one
// sentence — the archived tab showed "TOTAL 1 · IN REVIEW 6 pending" over a
// single archived row, and status is single-valued, so 6 of 1 events could not
// be awaiting review (tripl-4oqs). Same remedy as the coverage bar's "not
// implemented" (tripl-jfm3.29): name the bucket so two adjacent numbers stop
// reading as one.
const IN_REVIEW_HELP =
  'Events whose status is In Review across the whole project on this branch. It ignores the tab, filters and search, so it can be larger than the Total beside it — that one counts only what the current tab and filters match.'

/**
 * The `(i)` affordance beside a stat whose scope is not self-evident. A Radix
 * tooltip rather than a bare `title`, so the note opens on keyboard focus as
 * well as hover; the icon stays aria-hidden because the trigger's label already
 * carries the sentence. The provider is local because the header renders
 * outside EventsTable's, and Radix throws without one in scope.
 */
function StatHelp({ help }: { help: string }) {
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex shrink-0 self-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            aria-label={help}
          >
            <Info className="h-3 w-3" style={{ color: 'var(--fg-faint)' }} aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="max-w-xs whitespace-normal">
          {help}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function EventsHeader({
  total,
  inReviewCount,
  projectTotalSignal,
  eventTypeSignals,
  activeType = null,
}: {
  total: number
  /**
   * Events whose STATUS is `in_review` — not the count of unreviewed events.
   * The two are independent axes (an event can be marked reviewed and still be
   * in_review), and the old `unreviewedCount` name claimed otherwise while the
   * "Mark reviewed" button next to it moved neither this number nor the queue
   * (tripl-invv).
   */
  inReviewCount: number
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
      {/* Wraps rather than overflows: the scoped "In review · project" caption
          is the widest label in the row, and on a phone-width viewport the
          three stats no longer fit the line the heading leaves them. */}
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
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
          <StatHelp help={CHART_SIGNALS_HELP} />
        </div>
        <MiniStatDivider />
        <div className="inline-flex items-center gap-1">
          <MiniStat
            label="In review · project"
            value={String(inReviewCount)}
            delta={inReviewCount > 0 ? 'pending' : undefined}
            tone={inReviewCount > 0 ? 'warning' : 'success'}
          />
          <StatHelp help={IN_REVIEW_HELP} />
        </div>
      </div>
    </div>
  )
}
