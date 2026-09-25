import { Info } from 'lucide-react'

import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import { ScenarioCoachMark } from '@/demo/ScenarioCoachMark'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { EventType, MonitoringSignal } from '@/types'

import { EventDriftBadge } from './EventDriftBadge'

/** One event type with open schema drift, as the header shows it. */
export type EventTypeDrift = {
  eventTypeId: string
  label: string
  count: number
  /** The coached demo step points at this badge (reconcile/review-drift). */
  coach?: boolean
}

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
  'Events whose status is In Review across the whole project on this branch. It ignores the tab, filters and search, so it can be larger than the count beside it — that one counts only what the current tab and filters match.'

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

/**
 * Open schema drift, one badge per event type (EVT-33). The page header shows
 * it; the embedded table (an event type's detail view), which has no header,
 * shows it above its toolbar.
 */
export function EventTypeDriftBadges({
  slug,
  typeDrifts,
  namesType,
}: {
  slug: string
  typeDrifts: EventTypeDrift[]
  /** The page already names the one type shown, so the badge need not. */
  namesType: boolean
}) {
  if (typeDrifts.length === 0) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 self-center">
      {typeDrifts.map(drift => (
        <ScenarioCoachMark key={drift.eventTypeId} step="reconcile/review-drift" when={!!drift.coach}>
          {/* A span, not the badge itself: the badge's own root is a
              Radix PopoverTrigger slot, which must keep its ref. */}
          <span className="inline-flex">
            <EventDriftBadge
              slug={slug}
              eventTypeId={drift.eventTypeId}
              count={drift.count}
              typeLabel={namesType ? undefined : drift.label}
            />
          </span>
        </ScenarioCoachMark>
      ))}
    </span>
  )
}

export function EventsHeader({
  total,
  columnFilter = null,
  inReviewCount,
  projectTotalSignal,
  eventTypeSignals,
  activeType = null,
  slug,
  typeDrifts = [],
}: {
  /**
   * Events the tab, search and server-side filters match (the server count);
   * formatted like the table footer.
   */
  total: number
  /**
   * Set while a column (field/meta) filter narrows the table. Those filters are
   * client-side, so `total` does not count their matches; the header then says
   * what the footer does — the matches among the rows checked so far.
   */
  columnFilter?: { matching: number; checked: number } | null
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
  slug?: string
  /**
   * Open schema drift, once per event type. Drift belongs to the type, and the
   * backend copies the type's count onto every event of it, so a badge per row
   * repeated the same number down hundreds of rows and read as a per-event
   * count (EVT-33).
   */
  typeDrifts?: EventTypeDrift[]
}) {
  const liveSignalCount = eventTypeSignals.size + (projectTotalSignal ? 1 : 0)
  const hasLiveSignal = eventTypeSignals.size > 0 || !!projectTotalSignal

  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-4">
      <div className="flex items-baseline gap-2.5">
        <h1 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">
          {activeType ? `${activeType.display_name} events` : 'Events'}
        </h1>
        {slug && (
          <EventTypeDriftBadges slug={slug} typeDrifts={typeDrifts} namesType={!!activeType} />
        )}
      </div>
      {/* Wraps rather than overflows: the scoped "In review · project" caption
          is the widest label in the row, and on a phone-width viewport the
          three stats no longer fit the line the heading leaves them. */}
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
        {/* The one place the count appears in the header: the heading used to
            repeat it beside the h1, unformatted, while the footer formatted
            the same number (EVT-16). */}
        {columnFilter ? (
          <MiniStat
            label="Matching"
            value={columnFilter.matching.toLocaleString()}
            delta={`${columnFilter.checked.toLocaleString()} of ${total.toLocaleString()} checked`}
          />
        ) : (
          <MiniStat label="Total" value={total.toLocaleString()} />
        )}
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
