import {
  AlertTriangle,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  TrendingUp,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { activityApi } from '@/api/activity'
import { Dot } from '@/components/primitives/dot'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import { useNow } from '@/hooks/useNow'
import { formatRelativeTime } from '@/lib/datetime'
import { resolveActivityTargetPath } from '@/lib/navigation'
import { countOf } from '@/lib/plural'
import type { ActivityItem, ActivityItemSeverity, ActivityItemType } from '@/types'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { activityKey } from '@/lib/queryKeys'

const ACTIVITY_LIMIT = 20

// The rail earns its full width only when it has something to show. An empty
// feed narrows to a slim strip so it stops reading as permanent empty chrome on
// brand-new / quiet projects (tripl-yfsj.8).
const RAIL_WIDTH = 'w-[304px]'
const RAIL_WIDTH_QUIET = 'w-[220px]'

// One scan implements every discovered event in a single pass, so each of those
// items shares the scan's completion timestamp and lands as a burst of
// near-identical rows. Collapse a run of same-type items that arrived within
// this window into one expandable summary instead of flooding the feed.
const BURST_WINDOW_MS = 2 * 60_000
// Runs smaller than this read fine expanded; only collapse a genuine flood.
const MIN_BURST = 3
// How many item names to preview on a collapsed summary row before "+N more".
const PREVIEW_NAMES = 3

const KIND_ICON: Record<ActivityItemType, LucideIcon> = {
  anomaly: AlertTriangle,
  scan: TrendingUp,
  alert: Bell,
  event: Check,
}

// The noun a collapsed burst counts. A `scan` item is one scan RUN, not one
// scan, so three completed runs of one nightly scan must read "3 runs
// completed" — "3 scans completed" claimed the project had three scans
// (tripl-3y7z). The title stem already carries the scan noun ("Scan completed").
const TYPE_PLURAL: Record<ActivityItemType, string> = {
  anomaly: 'anomalies',
  scan: 'runs',
  alert: 'alerts',
  event: 'events',
}

const SEVERITY_RANK: Record<ActivityItemSeverity, number> = {
  high: 2,
  medium: 1,
  low: 0,
}

function severityColor(sev: ActivityItemSeverity): string {
  switch (sev) {
    case 'high':
      return 'var(--danger)'
    case 'medium':
      return 'var(--warning)'
    default:
      return 'var(--fg-muted)'
  }
}

// Backend copy is "<Noun> <action>: <name>" (e.g. "Event implemented: Signup").
// The stem before ": " identifies what happened; the suffix is the item name.
function titleStem(title: string): string {
  const sep = title.indexOf(': ')
  return sep === -1 ? title : title.slice(0, sep)
}

function itemName(item: ActivityItem): string {
  const sep = item.title.indexOf(': ')
  return sep === -1 ? item.title : item.title.slice(sep + 2)
}

function burstKey(item: ActivityItem): string {
  return `${item.type}::${titleStem(item.title)}`
}

function withinWindow(a: string, b: string): boolean {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false
  return Math.abs(ta - tb) <= BURST_WINDOW_MS
}

// A burst always holds at least one item, so its head is always present.
type Burst = [ActivityItem, ...ActivityItem[]]

type FeedEntry =
  | { kind: 'single'; item: ActivityItem }
  | { kind: 'group'; id: string; items: Burst }

// Collapse consecutive same-type items that arrived in one burst (same scan /
// tight time window) into a single expandable group; everything else stays a
// standalone row. The feed is already newest-first, so a burst is contiguous.
function buildFeed(items: readonly ActivityItem[]): FeedEntry[] {
  const entries: FeedEntry[] = []
  const flush = (run: Burst) => {
    if (run.length >= MIN_BURST) {
      entries.push({ kind: 'group', id: `group:${run[0].id}`, items: run })
    } else {
      for (const item of run) entries.push({ kind: 'single', item })
    }
  }
  let run: Burst | null = null
  let prev: ActivityItem | null = null
  for (const item of items) {
    if (
      run &&
      prev &&
      burstKey(item) === burstKey(run[0]) &&
      withinWindow(prev.occurred_at, item.occurred_at)
    ) {
      run.push(item)
    } else {
      if (run) flush(run)
      run = [item]
    }
    prev = item
  }
  if (run) flush(run)
  return entries
}

// "Event implemented" -> "implemented": drop the leading noun so the summary
// reads "12 events implemented" instead of repeating the noun.
function burstAction(stem: string): string {
  const sep = stem.indexOf(' ')
  return sep === -1 ? '' : stem.slice(sep + 1).toLowerCase()
}

function groupSummary(items: Readonly<Burst>): string {
  const action = burstAction(titleStem(items[0].title))
  const noun = TYPE_PLURAL[items[0].type]
  return action ? `${items.length} ${noun} ${action}` : `${items.length} ${noun}`
}

function groupPreview(items: readonly ActivityItem[]): string {
  const names = items.map(itemName)
  const shown = names.slice(0, PREVIEW_NAMES)
  const extra = names.length - shown.length
  return extra > 0 ? `${shown.join(', ')} +${extra} more` : shown.join(', ')
}

function groupSeverity(items: readonly ActivityItem[]): ActivityItemSeverity {
  return items.reduce<ActivityItemSeverity>(
    (worst, item) =>
      SEVERITY_RANK[item.severity] > SEVERITY_RANK[worst] ? item.severity : worst,
    'low',
  )
}

// ───────── Is the rail beside the page right now? ─────────
//
// Overview's own "Recent activity" panel repeated the rail item for item when
// the rail sat inline next to it (LIVE-10). The page cannot see the shell's
// state, so each open INLINE panel counts itself here. Layout says which one
// is inline (`inline`), so the width threshold lives in Layout alone: below it
// the panel is a modal drawer that covers the page, and hiding the page's panel
// behind it would only reflow the page.
let inlineRails = 0
const railListeners = new Set<() => void>()

function subscribeRail(listener: () => void): () => void {
  railListeners.add(listener)
  return () => {
    railListeners.delete(listener)
  }
}

function railIsInline(): boolean {
  return inlineRails > 0
}

/** True while the activity rail is open inline beside the page content. */
// eslint-disable-next-line react-refresh/only-export-components
export function useActivityRailInline(): boolean {
  return useSyncExternalStore(subscribeRail, railIsInline, () => false)
}

export function ActivityPanel({
  open,
  slug,
  inline = false,
}: {
  open: boolean
  slug?: string
  /** Rendered in the page's flow beside the content, not as the drawer. */
  inline?: boolean
}) {
  useEffect(() => {
    if (!open || !inline) return
    inlineRails += 1
    railListeners.forEach((listener) => listener())
    return () => {
      inlineRails -= 1
      railListeners.forEach((listener) => listener())
    }
  }, [open, inline])

  // Adaptive fallback: the live stream refreshes the feed via the invalidation
  // map, so poll only while the stream is unavailable (and never on a hidden tab).
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })
  const activityQuery = useQuery({
    meta: SILENT_ERROR_META,
    queryKey: activityKey(slug),
    queryFn: () => activityApi.list({ slug, limit: ACTIVITY_LIMIT }),
    enabled: open,
    staleTime: 30_000,
    refetchInterval,
  })

  const now = useNow(60_000)

  if (!open) return null

  const items = activityQuery.data ?? []
  const isInitialLoading = activityQuery.isLoading && items.length === 0
  // A failed refresh keeps what was already loaded: one missed poll used to
  // replace a good feed with "Activity unavailable" (SHELL-40).
  const hasItems = items.length > 0
  // Quiet = loaded, healthy, and genuinely empty. Only then do we shrink the
  // rail and drop its footer so it stops dominating an empty project.
  const isQuiet = !isInitialLoading && !activityQuery.isError && items.length === 0
  const feed = buildFeed(items)

  return (
    <aside
      aria-label="Activity feed"
      className={`flex ${isQuiet ? RAIL_WIDTH_QUIET : RAIL_WIDTH} flex-shrink-0 flex-col border-l`}
      style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border)' }}
    >
      <div
        className="flex h-11 items-center gap-2 border-b px-3.5"
        style={{ borderColor: 'var(--border)' }}
      >
        <Dot tone={activityQuery.isError ? 'warning' : 'accent'} pulse={activityQuery.isFetching} size={7} />
        <span className="text-body-sm font-semibold">Recent activity</span>
        {!isQuiet && (
          <span className="text-caption" style={{ color: 'var(--fg-subtle)' }}>
            {activityQuery.isError ? 'offline' : 'auto-refresh'}
          </span>
        )}
        <div className="flex-1" />
        {activityQuery.isFetching && (
          <Loader2 className="size-3.5 animate-spin" style={{ color: 'var(--fg-subtle)' }} />
        )}
        <button
          type="button"
          onClick={() => {
            void activityQuery.refetch()
          }}
          className="p-1"
          style={{ color: 'var(--fg-subtle)' }}
          aria-label="Refresh activity"
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {isInitialLoading && <ActivitySkeleton />}
        {activityQuery.isError && hasItems && (
          <div
            role="status"
            className="mx-3.5 mb-2 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-caption"
            style={{
              background: 'var(--surface)',
              borderColor: 'var(--border-subtle)',
              color: 'var(--fg-subtle)',
            }}
          >
            <span className="flex-1">Could not refresh; showing the last loaded items.</span>
            <button
              type="button"
              onClick={() => {
                void activityQuery.refetch()
              }}
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 transition-colors hover:bg-[var(--surface-hover)]"
              style={{ color: 'var(--fg)' }}
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              Retry
            </button>
          </div>
        )}
        {activityQuery.isError && !isInitialLoading && !hasItems && (
          <div className="px-3.5 py-3">
            <div
              className="rounded-md border p-3 text-caption"
              style={{
                background: 'var(--surface)',
                borderColor: 'var(--border-subtle)',
                color: 'var(--fg-subtle)',
              }}
            >
              <div className="font-medium" style={{ color: 'var(--fg)' }}>
                Activity unavailable
              </div>
              <div className="mt-1 leading-[1.35]">
                The feed could not be loaded from the backend.
              </div>
              <button
                type="button"
                onClick={() => {
                  void activityQuery.refetch()
                }}
                className="mt-2 inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-caption transition-colors hover:bg-[var(--surface-hover)]"
                style={{ color: 'var(--fg)' }}
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            </div>
          </div>
        )}
        {isQuiet && (
          <div className="px-3.5 py-6 text-center text-caption" style={{ color: 'var(--fg-subtle)' }}>
            No recent activity
          </div>
        )}
        {!isInitialLoading &&
          feed.map((entry) =>
            entry.kind === 'group' ? (
              <ActivityGroupRow key={entry.id} items={entry.items} showProject={!slug} now={now} />
            ) : (
              <ActivityRow key={entry.item.id} item={entry.item} showProject={!slug} now={now} />
            ),
          )}
      </div>
      {!isQuiet && (
        <div
          className="flex items-center gap-2 border-t px-3 py-2.5 text-caption"
          style={{ borderColor: 'var(--border)', color: 'var(--fg-subtle)' }}
        >
          <Zap className="h-3 w-3" />
          <span>
            last 7 days · {countOf(items.length, 'item', 'items')}
          </span>
        </div>
      )}
    </aside>
  )
}

const ROW_CLASS =
  'flex gap-2.5 px-3.5 py-[9px] no-underline transition-colors hover:bg-[var(--surface-hover)]'

function ActivityRow({
  item,
  showProject,
  now,
}: {
  item: ActivityItem
  showProject: boolean
  now: number
}) {
  const KindIcon = KIND_ICON[item.type]
  const sevColor = severityColor(item.severity)
  const content = (
    <>
      <div
        className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm"
        style={{
          background: 'var(--surface)',
          color: item.severity === 'low' ? 'var(--fg-muted)' : sevColor,
        }}
      >
        <KindIcon className="h-3 w-3" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-body-sm font-medium leading-[1.35]">{item.title}</div>
        <div
          className="mt-0.5 text-caption leading-[1.3]"
          style={{ color: 'var(--fg-subtle)' }}
        >
          {item.detail}
        </div>
        {/* Sans, not mono: a relative time is prose, not an identifier (DS-17). */}
        <div
          className="mt-[3px] text-caption font-medium"
          style={{ color: 'var(--fg-muted)' }}
        >
          {formatRelativeTime(item.occurred_at, now)}
          {showProject ? (
            <span style={{ color: 'var(--fg-faint)' }}>{` · ${item.project_slug}`}</span>
          ) : (
            ''
          )}
        </div>
      </div>
    </>
  )
  const style = {
    borderLeft: `2px solid ${
      item.severity === 'high' || item.severity === 'medium' ? sevColor : 'transparent'
    }`,
    color: 'inherit',
  }

  // Not `item.target_path` directly: the feed's alert rows arrive with the bare
  // /p/:slug/settings/alerting, which drops the reader at the top of a page
  // holding every delivery and every incident — strictly worse than the telegram
  // message the same delivery sent, which links to the exact row.
  // `resolveActivityTargetPath` rebuilds the deep link from the delivery id the
  // row already carries in its own id, and returns `target_path` untouched for
  // everything else (tripl-oxkt.21).
  const targetPath = resolveActivityTargetPath(item)

  if (targetPath) {
    return (
      <Link to={targetPath} className={ROW_CLASS} style={style}>
        {content}
      </Link>
    )
  }

  return (
    <div className={ROW_CLASS} style={style}>
      {content}
    </div>
  )
}

// A collapsed burst: one summary row that expands to reveal the individual
// items it stands in for.
function ActivityGroupRow({
  items,
  showProject,
  now,
}: {
  items: Burst
  showProject: boolean
  now: number
}) {
  const [expanded, setExpanded] = useState(false)
  const first = items[0]
  const severity = groupSeverity(items)
  const sevColor = severityColor(severity)
  const KindIcon = KIND_ICON[first.type]
  const Chevron = expanded ? ChevronDown : ChevronRight

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full gap-2.5 px-3.5 py-[9px] text-left transition-colors hover:bg-[var(--surface-hover)]"
        style={{
          borderLeft: `2px solid ${severity === 'low' ? 'transparent' : sevColor}`,
          color: 'inherit',
        }}
      >
        <div
          className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm"
          style={{
            background: 'var(--surface)',
            color: severity === 'low' ? 'var(--fg-muted)' : sevColor,
          }}
        >
          <KindIcon className="h-3 w-3" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-body-sm font-medium leading-[1.35]">
            <Chevron
              className="h-3 w-3 shrink-0"
              style={{ color: 'var(--fg-muted)' }}
              aria-hidden="true"
            />
            <span>{groupSummary(items)}</span>
          </div>
          <div
            className="mt-0.5 truncate text-caption leading-[1.3]"
            style={{ color: 'var(--fg-subtle)' }}
          >
            {groupPreview(items)}
          </div>
          <div
            className="mt-[3px] text-caption font-medium"
            style={{ color: 'var(--fg-muted)' }}
          >
            {formatRelativeTime(first.occurred_at, now)}
            {showProject ? (
              <span style={{ color: 'var(--fg-faint)' }}>{` · ${first.project_slug}`}</span>
            ) : (
              ''
            )}
          </div>
        </div>
      </button>
      {expanded && (
        <div style={{ background: 'var(--surface)' }}>
          {items.map((item) => (
            <ActivityRow key={item.id} item={item} showProject={showProject} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}

function ActivitySkeleton() {
  return (
    <div className="space-y-1 py-1">
      {[0, 1, 2, 3, 4].map((item) => (
        <div key={item} className="flex gap-2.5 px-3.5 py-[9px]">
          <div className="h-[22px] w-[22px] rounded-sm bg-[var(--surface)]" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-4/5 rounded-sm bg-[var(--surface)]" />
            <div className="h-2.5 w-3/5 rounded-sm bg-[var(--surface)]" />
            <div className="h-2 w-16 rounded-sm bg-[var(--surface)]" />
          </div>
        </div>
      ))}
    </div>
  )
}
