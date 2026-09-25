import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowDown, ArrowUp, ChevronLeft, Code, Eye, MoreHorizontal, Pencil, TrendingUp,
} from 'lucide-react'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { Skeleton } from '@/components/ui/skeleton'
import { MetricsChart } from '@/components/ui/chart-lazy'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useBranchLinkProps } from '@/hooks/useBranch'
import { formatIncidentCount } from '@/lib/alertStatus'
import { formatRelativeTime, formatTimestamp } from '@/lib/datetime'
import { eventNameLabel } from '@/lib/eventName'
import { EVENT_STATUS_LABELS, EVENT_STATUS_TONE, type EventStatus } from '@/lib/eventStatus'
import { granularityForInterval } from '@/lib/metricAdapters'
import { formatSignalSeverity } from '@/lib/monitoring'
import { NO_BASELINE_LABEL, formatRatioDelta, ratioDelta } from '@/lib/percentDelta'
import type { Event as TEvent, EventMetricPoint, EventMetricsResponse, EventType, MonitoringSignal } from '@/types'
import { computeEventStats, type EventDetailStats } from './eventStats'
import { SURFACE_STYLE } from './surface'

function formatNum(value: number): string {
  return value.toLocaleString()
}

export function EventDetailHero({
  slug,
  event,
  eventType,
  metrics,
  onEdit,
  onMetrics,
}: {
  slug: string
  event: TEvent
  eventType: EventType | undefined
  metrics: EventMetricsResponse | undefined
  /** Omitted for a viewer, who gets no Edit action. */
  onEdit?: () => void
  onMetrics: () => void
}) {
  const stats = computeEventStats(metrics?.data)
  const signal = metrics?.latest_signal ?? null
  const signalTone: 'danger' | 'warning' = signal?.direction === 'drop' ? 'warning' : 'danger'
  return (
    <div className="space-y-[18px]">
      <EventDetailBreadcrumb slug={slug} name={event.name} branchId={event.branch_id ?? null} />
      <EventDetailHeader event={event} eventType={eventType} signal={signal} onEdit={onEdit} onMetrics={onMetrics} />
      {signal && <EventSignalBanner signal={signal} tone={signalTone} />}
      {signal && (
        <EventSignalMiniChart
          data={metrics?.data ?? []}
          interval={metrics?.interval ?? null}
          sigmaThreshold={metrics?.sigma_threshold}
          signal={signal}
          tone={signalTone}
        />
      )}
      <EventStatStrip event={event} stats={stats} />
    </div>
  )
}

/**
 * "Plan / Events / <name>". Plan is the sidebar group, not a page, so it is
 * plain text; Events is a real link to the catalog. Both crumbs used to pop
 * history, so "Plan" could land the reader on Anomalies or wherever they had
 * come from (MON-38). The Prev/Next buttons that sat here were permanently
 * disabled "Coming soon" placeholders and are gone until they work.
 */
function EventDetailBreadcrumb({
  slug,
  name,
  branchId,
}: {
  slug: string
  name: string
  branchId: string | null
}) {
  const branchLink = useBranchLinkProps()
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[11.5px]">
      <span style={{ color: 'var(--fg-subtle)' }}>Plan</span>
      <span aria-hidden style={{ color: 'var(--fg-faint)' }}>/</span>
      <Link
        {...branchLink(`/p/${slug}/events`, branchId)}
        className="inline-flex items-center gap-1 transition-colors hover:text-[var(--fg)]"
        style={{ color: 'var(--fg-muted)' }}
      >
        <ChevronLeft aria-hidden size={13} /> Events
      </Link>
      <span aria-hidden style={{ color: 'var(--fg-faint)' }}>/</span>
      {/* A blank name left this crumb empty, so the trail ended in nothing
          (tripl-wkwv.5). Plain string rather than <EventName>: the crumb
          truncates and carries its own native title. */}
      <span
        aria-current="page"
        className="mono min-w-0 truncate"
        style={{ color: 'var(--fg)' }}
        title={eventNameLabel(name)}
      >
        {eventNameLabel(name)}
      </span>
    </nav>
  )
}

function HeroAction({
  icon,
  label,
  primary,
  onClick,
  disabled,
  title,
}: {
  icon: ReactNode
  label: string
  primary?: boolean
  onClick?: () => void
  disabled?: boolean
  /** Hover/long-press hint — used to explain why a disabled action is inert. */
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex h-8 items-center gap-[6px] rounded-[7px] border px-[10px] text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        background: primary ? 'var(--accent)' : 'var(--surface)',
        color: primary ? 'var(--accent-fg)' : 'var(--fg)',
        borderColor: primary ? 'var(--accent)' : 'var(--border)',
      }}
    >
      {icon} {label}
    </button>
  )
}

function EventDetailHeader({
  event,
  eventType,
  signal,
  onEdit,
  onMetrics,
}: {
  event: TEvent
  eventType: EventType | undefined
  signal: MonitoringSignal | null
  onEdit?: () => void
  onMetrics: () => void
}) {
  const status = event.status as EventStatus
  const statusTone = EVENT_STATUS_TONE[status] ?? 'neutral'
  const typeColor = eventType?.color ?? 'var(--fg-faint)'
  const typeLabel = eventType?.display_name ?? event.event_type?.display_name ?? 'Event'
  return (
    <div className="flex flex-wrap items-start gap-[13px]">
      <span className="mt-[7px] flex-shrink-0">
        {signal
          ? <Dot tone={signal.direction === 'drop' ? 'warning' : 'danger'} pulse size={8} />
          : <Dot tone={statusTone} size={8} />}
      </span>
      {/* `basis-60` makes the title column ask for 240px, so on a phone the
          action group below wraps onto its own line instead of the heading
          being crushed to ~107px and painted under the buttons
          (tripl-jfm3.41). `break-all` then wraps a long mono event name rather
          than letting it overflow the column. */}
      <div className="min-w-0 flex-1 basis-60">
        <div className="flex flex-wrap items-center gap-[10px]">
          {/* Never an empty top-level heading: a blank name gave the whole page
              no accessible title (tripl-wkwv.5). */}
          <h1 className="mono m-0 min-w-0 break-all text-[19px] font-semibold tracking-[-0.01em]">
            {eventNameLabel(event.name)}
          </h1>
          <Chip tone={statusTone} size="sm">{EVENT_STATUS_LABELS[status] ?? event.status}</Chip>
          {event.tags.map(tag => <Chip key={tag.id} size="xs">{tag.name}</Chip>)}
        </div>
        <div className="mt-[7px] flex flex-wrap items-center gap-2 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
          <span className="inline-flex items-center gap-[5px]">
            <span className="h-[7px] w-[7px] rounded-[2px]" style={{ background: typeColor }} />
            {typeLabel}
          </span>
          <span style={{ color: 'var(--fg-faint)' }}>·</span>
          <span>updated {formatRelativeTime(event.updated_at)}</span>
        </div>
        {event.description && (
          <p className="mt-[7px] max-w-[62ch] text-[13px] leading-snug" style={{ color: 'var(--fg-muted)' }}>
            {event.description}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <HeroAction icon={<TrendingUp size={12} />} label="Metrics" onClick={onMetrics} />
        {onEdit && <HeroAction icon={<Pencil size={12} />} label="Edit" primary onClick={onEdit} />}
        <EventActionOverflow />
      </div>
    </div>
  )
}

/**
 * Overflow ("…") menu for not-yet-shipped actions. Keeping Watch / Implementation
 * out of the primary row — rather than as inert disabled buttons beside the live
 * ones — stops the dead CTAs from undercutting confidence in the working actions.
 */
function EventActionOverflow() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="More actions"
          className="inline-flex h-8 w-8 items-center justify-center rounded-[7px] border transition-colors hover:bg-[var(--surface-hover)]"
          style={{ background: 'var(--surface)', color: 'var(--fg-muted)', borderColor: 'var(--border)' }}
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-[180px]">
        <DropdownMenuLabel
          className="text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: 'var(--fg-faint)' }}
        >
          Coming soon
        </DropdownMenuLabel>
        <DropdownMenuItem disabled className="text-[12.5px]">
          <Eye className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} /> Watch
        </DropdownMenuItem>
        <DropdownMenuItem disabled className="text-[12.5px]">
          <Code className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} /> Implementation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function EventSignalBanner({ signal, tone }: { signal: MonitoringSignal; tone: 'danger' | 'warning' }) {
  // No baseline is a fact about the signal, not a missing value: dropping the
  // clause left the banner silently shorter on exactly the anomalies that moved
  // the most — an event firing where nothing was expected, a scope resuming
  // after an outage — so it says so instead (tripl-l429.27).
  const delta = ratioDelta(signal.actual_count, signal.expected_count)
  const Arrow = signal.direction === 'drop' ? ArrowDown : ArrowUp
  return (
    <div
      className="flex items-center gap-[10px] rounded-[10px] px-[14px] py-[10px]"
      style={{
        background: `var(--${tone}-soft)`,
        border: `1px solid color-mix(in oklab, var(--${tone}) 35%, var(--border))`,
      }}
    >
      <Arrow size={15} style={{ color: `var(--${tone})` }} />
      <span className="text-[12.5px]" style={{ color: 'var(--fg-muted)' }}>
        {signal.direction === 'drop' ? 'Volume drop' : 'Volume spike'} detected
        {delta === null
          ? ` — ${NO_BASELINE_LABEL} to compare against`
          : ` — ${formatRatioDelta(delta)} vs. baseline`}
        {` (${formatSignalSeverity(signal)}).`}
      </span>
      <div className="flex-1" />
      <span className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
        {formatTimestamp(signal.bucket)}
      </span>
    </div>
  )
}

/**
 * Compact volume chart rendered beside {@link EventSignalBanner} so the anomaly
 * the banner describes is visible in context, without the extra click into the
 * Metrics tab. Reuses the already-fetched series and the same
 * {@link MetricsChart}; native granularity keeps the flagged point
 * un-aggregated, so its anomaly dot never merges into a neighbouring bucket.
 *
 * It is titled "Volume", not "Volume vs. baseline". MetricsChart does draw a
 * dashed expectation and a sigma band from each point's expected_count/stddev,
 * but the backend fills those two fields ONLY on buckets it flagged
 * (metrics_service._build_metric_points): the expected series has a single
 * non-null point, and a `connectNulls={false} dot={false}` Line through one
 * point paints nothing. So the panel promised the comparison that justifies the
 * alert and then showed one bare series — the reader had to take "+198% vs.
 * baseline" on faith from the chart they were handed to check it with. The one
 * baseline that does exist is the flagged bucket's, so it is named in words
 * beside the title instead of implied by a line that is not there (tripl-v2lm).
 */
function EventSignalMiniChart({
  data,
  interval,
  sigmaThreshold,
  signal,
  tone,
}: {
  data: EventMetricPoint[]
  interval: string | null
  /** `EventMetricsResponse.sigma_threshold`, threaded from the hero's already-fetched series. */
  sigmaThreshold: number | undefined
  signal: MonitoringSignal
  tone: 'danger' | 'warning'
}) {
  if (data.length === 0) return null
  const granularity = granularityForInterval(interval) ?? 'hour'
  return (
    <div
      data-testid="signal-volume-chart"
      className="rounded-[10px] border px-[14px] pb-[6px] pt-[10px]"
      style={SURFACE_STYLE}
    >
      <div className="mb-[6px] flex items-baseline justify-between gap-3 text-[11px]">
        <span className="font-medium" style={{ color: 'var(--fg-subtle)' }}>Volume</span>
        {/* Same `expected > 0` gate the banner uses, so the two cannot disagree
            about whether this signal had a baseline at all — and the SAME
            value-aware formatter the signal card 1200 lines up already uses, so
            they cannot disagree about what it was. `expected_count` is a mean of
            prior buckets, so a rare event's baseline is legitimately sub-unit
            (0.4/hour); `Math.round` wrote that as "baseline 0", contradicting
            the gate that had just decided a baseline existed. */}
        <span style={{ color: 'var(--fg-faint)' }}>
          {signal.expected_count > 0
            ? `baseline ${formatIncidentCount(signal.expected_count)} at the flagged bucket`
            : `${NO_BASELINE_LABEL} at the flagged bucket`}
        </span>
      </div>
      <MetricsChart
        data={data}
        height={104}
        color={`var(--${tone})`}
        granularity={granularity}
        seriesLabel="events"
        sigmaThreshold={sigmaThreshold}
      />
    </div>
  )
}

function StatCard({
  label,
  value,
  tone,
  hint,
  empty,
}: {
  label: string
  value: string
  tone?: 'danger' | 'warning'
  /** Hover/long-press explanation, e.g. for an empty "—" value. */
  hint?: string
  /** De-emphasise the value when it represents a no-data ("—" / "0") state. */
  empty?: boolean
}) {
  const color = empty
    ? 'var(--fg-faint)'
    : tone === 'danger'
      ? 'var(--danger)'
      : tone === 'warning'
        ? 'var(--warning)'
        : 'var(--fg)'
  return (
    <div className="rounded-[10px] border px-[14px] py-[11px]" style={SURFACE_STYLE} title={hint}>
      <div className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>{label}</div>
      <div className="mono tnum mt-1 text-[19px] font-medium" style={{ color }}>{value}</div>
    </div>
  )
}

function EventStatStrip({ event, stats }: { event: TEvent; stats: EventDetailStats }) {
  const deltaTone: 'danger' | 'warning' | undefined = stats.delta24h == null
    ? undefined
    : stats.delta24h > 20 ? 'danger' : stats.delta24h < -20 ? 'warning' : undefined
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard
        label="Volume · 24h"
        value={stats.volume24h == null ? '—' : formatNum(stats.volume24h)}
        empty={stats.volume24h == null}
        hint={stats.volume24h == null ? 'No events in the last 24h' : undefined}
      />
      <StatCard
        label="Δ · 24h"
        // The Events list's figure and its "*" for a window short of 24h, so
        // the two surfaces cannot disagree about the same event (MON-28).
        value={stats.delta24h == null
          ? '—'
          : `${stats.delta24h > 0 ? '+' : ''}${stats.delta24h.toFixed(0)}%${stats.partial ? '*' : ''}`}
        tone={deltaTone}
        empty={stats.delta24h == null}
        hint={stats.deltaHint}
      />
      <StatCard
        label="Schema drifts"
        value={formatNum(event.drift_count)}
        tone={event.drift_count > 0 ? 'warning' : undefined}
        // Zero drifts is a real, reassuring count — render "0", not the
        // no-data glyph the empty state would otherwise show.
        hint={event.drift_count === 0 ? 'No schema drifts detected' : undefined}
      />
      <StatCard
        label="Last seen"
        value={event.last_seen_at ? formatRelativeTime(event.last_seen_at) : '—'}
        empty={!event.last_seen_at}
        hint={event.last_seen_at ? undefined : 'No hits recorded yet'}
      />
    </div>
  )
}

/**
 * Hero-shaped placeholder while the event loads. Without it the page painted
 * the generic header ("Event", "Back to events") full width first and then
 * jumped to the hero inside the narrower column (MON-9).
 */
export function EventDetailSkeleton() {
  return (
    <div role="status" aria-label="Loading event" className="space-y-[18px]">
      <Skeleton className="h-4 w-48" />
      <div className="space-y-2">
        <Skeleton className="h-6 w-64 max-w-full" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-[62px]" />)}
      </div>
      <Skeleton className="h-[240px]" />
    </div>
  )
}
