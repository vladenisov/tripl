import type { ReactNode } from 'react'
import {
  ArrowDown, ArrowUp, Code, Eye, MoreHorizontal, Pencil, TrendingUp,
} from 'lucide-react'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { MiniStat, MiniStatStrip, type MiniStatTone } from '@/components/primitives/mini-stat'
import { PageHeader } from '@/components/primitives/page-header'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { MetricsChart } from '@/components/ui/chart-lazy'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatIncidentCount } from '@/lib/alertStatus'
import { formatRelativeTime, formatTimestamp } from '@/lib/datetime'
import { eventNameLabel } from '@/lib/eventName'
import { EVENT_STATUS_LABELS, EVENT_STATUS_TONE, type EventStatus } from '@/lib/eventStatus'
import { granularityForInterval } from '@/lib/metricAdapters'
import { formatSignalSeverity } from '@/lib/monitoring'
import { NO_BASELINE_LABEL, formatRatioDelta, ratioDelta } from '@/lib/percentDelta'
import { signalDirectionTone, type SignalDirectionTone } from '@/lib/statusLexicon'
import type { Event as TEvent, EventMetricPoint, EventMetricsResponse, EventType, MonitoringSignal } from '@/types'
import { computeEventStats, type EventDetailStats } from './eventStats'
import { SURFACE_STYLE } from './surface'

function formatNum(value: number): string {
  return value.toLocaleString()
}

export function EventDetailHero({
  event,
  eventType,
  metrics,
  onEdit,
  onMetrics,
}: {
  event: TEvent
  eventType: EventType | undefined
  metrics: EventMetricsResponse | undefined
  /** Omitted for a viewer, who gets no Edit action. */
  onEdit?: () => void
  onMetrics: () => void
}) {
  const stats = computeEventStats(metrics?.data)
  const signal = metrics?.latest_signal ?? null
  const signalTone = signalDirectionTone(signal?.direction ?? 'spike')
  return (
    <div className="space-y-[18px]">
      <EventDetailHeader
        event={event}
        eventType={eventType}
        signal={signal}
        onEdit={onEdit}
        onMetrics={onMetrics}
        stats={<EventStatStrip event={event} stats={stats} />}
      />
      {signal && <EventSignalBanner signal={signal} tone={signalTone} />}
      {signal && (
        <EventSignalMiniChart
          data={metrics?.data ?? []}
          interval={metrics?.interval ?? null}
          sigmaThreshold={metrics?.sigma_threshold}
          signal={signal}
        />
      )}
    </div>
  )
}

/**
 * The shared page header (DS-1): one h1 in the page title's sans, since the
 * name is a display name and not code (DS-17); the nav group and collection
 * as the eyebrow; the KPI strip in its `stats` slot (DS-5). The in-page
 * "Plan / Events / <name>" breadcrumb that sat above it repeated the top bar's
 * trail 120px apart (DS-3 / JR-33), so the top bar is the one trail now.
 */
function EventDetailHeader({
  event,
  eventType,
  signal,
  onEdit,
  onMetrics,
  stats,
}: {
  event: TEvent
  eventType: EventType | undefined
  signal: MonitoringSignal | null
  onEdit?: () => void
  onMetrics: () => void
  stats: ReactNode
}) {
  const status = event.status as EventStatus
  const statusTone = EVENT_STATUS_TONE[status] ?? 'neutral'
  const typeColor = eventType?.color ?? 'var(--fg-faint)'
  const typeLabel = eventType?.display_name ?? event.event_type?.display_name ?? 'Event'
  return (
    <PageHeader
      eyebrow="Plan · Event"
      // Never an empty top-level heading: a blank name gave the whole page no
      // accessible title (tripl-wkwv.5). The status dot is decoration.
      title={
        <>
          <span className="mr-2.5 inline-flex align-middle">
            {signal
              ? <Dot tone={signalDirectionTone(signal.direction)} pulse size={8} />
              : <Dot tone={statusTone} size={8} />}
          </span>
          {eventNameLabel(event.name)}
        </>
      }
      titleAddon={
        <>
          <Chip tone={statusTone} size="sm">{EVENT_STATUS_LABELS[status] ?? event.status}</Chip>
          {/* Tags are kind tags: outline, not a status fill (DS-6). */}
          {event.tags.map(tag => <Chip key={tag.id} variant="outline" size="xs">{tag.name}</Chip>)}
        </>
      }
      description={
        <>
          <span className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-[5px]">
              <span className="h-[7px] w-[7px] rounded-sm" style={{ background: typeColor }} />
              {typeLabel}
            </span>
            <span style={{ color: 'var(--fg-faint)' }}>·</span>
            <span>updated {formatRelativeTime(event.updated_at)}</span>
          </span>
          {event.description && (
            <span className="mt-[7px] block max-w-[62ch] text-body leading-snug" style={{ color: 'var(--fg-muted)' }}>
              {event.description}
            </span>
          )}
        </>
      }
      // The Button primitive, so the primary Edit gets the shared hover, focus
      // ring and disabled look instead of an inline accent fill (AU-7).
      actions={
        <>
          <Button variant="outline" onClick={onMetrics}>
            <TrendingUp aria-hidden="true" />
            Metrics
          </Button>
          {onEdit && (
            <Button onClick={onEdit}>
              <Pencil aria-hidden="true" />
              Edit
            </Button>
          )}
          <EventActionOverflow />
        </>
      }
      stats={stats}
    />
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
        <Button variant="outline" size="icon" aria-label="More actions" className="text-fg-muted">
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-[180px]">
        <DropdownMenuLabel className="micro-label text-fg-tertiary">
          Coming soon
        </DropdownMenuLabel>
        <DropdownMenuItem disabled className="text-body-sm">
          <Eye className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} /> Watch
        </DropdownMenuItem>
        <DropdownMenuItem disabled className="text-body-sm">
          <Code className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} /> Implementation
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function EventSignalBanner({ signal, tone }: { signal: MonitoringSignal; tone: SignalDirectionTone }) {
  // No baseline is a fact about the signal, not a missing value: dropping the
  // clause left the banner silently shorter on exactly the anomalies that moved
  // the most — an event firing where nothing was expected, a scope resuming
  // after an outage — so it says so instead (tripl-l429.27).
  const delta = ratioDelta(signal.actual_count, signal.expected_count)
  const Arrow = signal.direction === 'drop' ? ArrowDown : ArrowUp
  return (
    <div
      className="flex items-center gap-[10px] rounded-card px-[14px] py-[10px]"
      style={{
        background: `var(--${tone}-soft)`,
        border: `1px solid color-mix(in oklab, var(--${tone}) 35%, var(--border))`,
      }}
    >
      <Arrow size={16} style={{ color: `var(--${tone})` }} />
      <span className="text-body-sm" style={{ color: 'var(--fg-muted)' }}>
        {signal.direction === 'drop' ? 'Volume drop' : 'Volume spike'} detected
        {delta === null
          ? ` — ${NO_BASELINE_LABEL} to compare against`
          : ` — ${formatRatioDelta(delta)} vs. baseline`}
        {` (${formatSignalSeverity(signal)}).`}
      </span>
      <div className="flex-1" />
      <span className="text-caption" style={{ color: 'var(--fg-subtle)' }}>
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
}: {
  data: EventMetricPoint[]
  interval: string | null
  /** `EventMetricsResponse.sigma_threshold`, threaded from the hero's already-fetched series. */
  sigmaThreshold: number | undefined
  signal: MonitoringSignal
}) {
  if (data.length === 0) return null
  const granularity = granularityForInterval(interval) ?? 'hour'
  return (
    <div
      data-testid="signal-volume-chart"
      className="rounded-card border px-[14px] pb-[6px] pt-[10px]"
      style={SURFACE_STYLE}
    >
      <div className="mb-[6px] flex items-baseline justify-between gap-3 text-caption">
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
        // No `color`: the chart's single-series default, the same colour as
        // the Volume tab below. The anomaly is marked by its danger dot and
        // band, not by painting the whole line red (DS-27).
        granularity={granularity}
        seriesLabel="events"
        sigmaThreshold={sigmaThreshold}
      />
    </div>
  )
}

/**
 * One stat of the header's KPI strip. The hover hint explains an empty value;
 * `empty` greys a no-data figure ("—") instead of printing it in full ink.
 */
function EventStat({
  label,
  value,
  tone,
  hint,
  empty,
}: {
  label: string
  value: string
  tone?: MiniStatTone
  /** Hover/long-press explanation, e.g. for an empty "—" value. */
  hint?: string
  /** De-emphasise the value when it represents a no-data ("—") state. */
  empty?: boolean
}) {
  return (
    <div title={hint}>
      <MiniStat
        label={label}
        value={empty ? <span style={{ color: 'var(--fg-faint)' }}>{value}</span> : value}
        valueTone={tone}
      />
    </div>
  )
}

/**
 * The page-KPI strip every page uses (DS-5), in place of four bordered tiles
 * with 19px mono figures: sans tabular figures (DS-17), so "2h ago" no longer
 * reads as code.
 */
function EventStatStrip({ event, stats }: { event: TEvent; stats: EventDetailStats }) {
  const deltaTone: MiniStatTone | undefined = stats.delta24h == null
    ? undefined
    : stats.delta24h > 20 ? 'danger' : stats.delta24h < -20 ? 'warning' : undefined
  return (
    <MiniStatStrip boxed>
      <EventStat
        label="Volume · 24h"
        value={stats.volume24h == null ? '—' : formatNum(stats.volume24h)}
        empty={stats.volume24h == null}
        hint={stats.volume24h == null ? 'No events in the last 24h' : undefined}
      />
      <EventStat
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
      <EventStat
        label="Schema drifts"
        value={formatNum(event.drift_count)}
        tone={event.drift_count > 0 ? 'warning' : undefined}
        // Zero drifts is a real, reassuring count — render "0", not the
        // no-data glyph the empty state would otherwise show.
        hint={event.drift_count === 0 ? 'No schema drifts detected' : undefined}
      />
      <EventStat
        label="Last seen"
        value={event.last_seen_at ? formatRelativeTime(event.last_seen_at) : '—'}
        empty={!event.last_seen_at}
        hint={event.last_seen_at ? undefined : 'No hits recorded yet'}
      />
    </MiniStatStrip>
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
      <Skeleton className="h-[58px]" />
      <Skeleton className="h-[240px]" />
    </div>
  )
}
