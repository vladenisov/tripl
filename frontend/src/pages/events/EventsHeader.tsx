import { formatNumber } from '@/lib/format'
import { Info } from 'lucide-react'

import { MiniStat, MiniStatStrip } from '@/components/primitives/mini-stat'
import { PageHeader } from '@/components/primitives/page-header'
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
            className="inline-flex shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            aria-label={help}
          >
            <Info className="size-3" style={{ color: 'var(--fg-faint)' }} aria-hidden />
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
  const openSignalCount = eventTypeSignals.size + (projectTotalSignal ? 1 : 0)
  const hasOpenSignal = openSignalCount > 0

  return (
    <PageHeader
      className="mb-3"
      eyebrow="Plan"
      title={activeType ? `${activeType.display_name} events` : 'Events'}
      titleAddon={
        slug ? (
          <EventTypeDriftBadges slug={slug} typeDrifts={typeDrifts} namesType={!!activeType} />
        ) : undefined
      }
      // The page KPIs sit under the title in the one boxed strip, as on
      // Overview, Metrics and Anomalies, instead of right-aligned in the
      // actions slot (DS-5). The strip wraps on a phone-width viewport.
      stats={
        <MiniStatStrip boxed>
          {/* The one place the count appears in the header: the heading used to
              repeat it beside the h1, unformatted, while the footer formatted
              the same number (EVT-16). */}
          {columnFilter ? (
            <MiniStat
              label="Matching"
              value={formatNumber(columnFilter.matching)}
              delta={`${formatNumber(columnFilter.checked)} of ${formatNumber(total)} checked`}
            />
          ) : (
            <MiniStat label="Total" value={formatNumber(total)} />
          )}
          {/* The help icon rides on the caption it explains: beside the whole
              stat it sat far from the label, next to the following stat
              (LIVE-23). "Open"/"none", not "live"/"quiet": "Live" is the
              lifecycle status of a shipped event, in green, one column over
              (EV-5 / DS-7). */}
          <MiniStat
            label="Chart signals"
            value={String(openSignalCount)}
            delta={hasOpenSignal ? 'open' : 'none'}
            tone={hasOpenSignal ? 'danger' : 'success'}
            pulse={hasOpenSignal}
            labelAddon={<StatHelp help={CHART_SIGNALS_HELP} />}
          />
          <MiniStat
            label="In review · project"
            value={String(inReviewCount)}
            delta={inReviewCount > 0 ? 'pending' : undefined}
            tone={inReviewCount > 0 ? 'warning' : 'success'}
            labelAddon={<StatHelp help={IN_REVIEW_HELP} />}
          />
        </MiniStatStrip>
      }
    />
  )
}
