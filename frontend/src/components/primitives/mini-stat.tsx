import { Children, type CSSProperties, type ReactNode } from 'react'
import { Dot, type DotTone } from '@/components/primitives/dot'
import { cn } from '@/lib/utils'

export type MiniStatTone = 'success' | 'danger' | 'warning' | 'info' | 'accent' | 'neutral'

type MiniStatProps = {
  label: string
  value: ReactNode
  delta?: ReactNode
  /**
   * Colours the `delta` (and its pulse dot). With no delta to ride on it
   * colours the figure instead: it used to show nothing at all, so Overview's
   * Implemented / Needs review / Coverage, the Coverage page and others passed
   * a tone that read as meaningful at the call site and never rendered (MON-42).
   */
  tone?: MiniStatTone
  /**
   * Colours the figure itself, whether or not there is a delta — for a stat
   * whose delta carries a different tone from its value.
   */
  valueTone?: MiniStatTone
  pulse?: boolean
  /**
   * Rendered inline right after the caption text, e.g. an info icon. Placed
   * beside the whole stat, the icon sat 60–100px from its caption on a wide
   * figure and read as belonging to the next stat (LIVE-23).
   */
  labelAddon?: ReactNode
}

const TONE_COLOR: Record<MiniStatTone, string> = {
  success: 'var(--success)',
  danger: 'var(--danger)',
  warning: 'var(--warning)',
  info: 'var(--info)',
  accent: 'var(--accent)',
  neutral: 'var(--fg-subtle)',
}

const TONE_DOT: Record<MiniStatTone, DotTone> = {
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  info: 'info',
  accent: 'accent',
  neutral: 'neutral',
}

/**
 * The one KPI idiom (DS-5): an uppercase 10.5px caption over a 16px sans
 * `tnum` figure, with an optional toned delta. Page stats go in a
 * `MiniStatStrip`; the bordered sentence-case `StatCard` tiles and the
 * Card-wrapped stat grids it replaces are gone.
 *
 * While the figure is still loading, pass `<StatValueSkeleton />` (from
 * `@/components/states`) as `value` and leave `delta` and `tone` off: a `?? 0`
 * fallback flashed "0" and "quiet" before the data arrived, which read as a
 * real answer (#237 DS-25).
 */
export function MiniStat({
  label,
  value,
  delta,
  tone = 'neutral',
  valueTone,
  pulse = false,
  labelAddon,
}: MiniStatProps) {
  // A definition list programmatically ties the value (<dd>) to its caption
  // (<dt>) so assistive tech announces "<label>: <value>" together, instead of
  // two unrelated <span>s. (Issue M9.)
  const figureTone = valueTone ?? (delta == null ? tone : undefined)
  const tint = figureTone && figureTone !== 'neutral' ? figureTone : undefined
  return (
    <dl className="m-0 flex flex-col gap-px">
      <dt
        className="inline-flex items-center gap-1 micro-label"
        style={{ color: 'var(--fg-faint)' }}
      >
        {label}
        {labelAddon}
      </dt>
      <dd className="m-0 flex items-baseline gap-1.5">
        {/* Sans with tabular digits, not mono: a KPI figure ("1h ago",
            "4.4K rows", "92%") is a number, not code (DS-17). */}
        <span
          data-slot="mini-stat-value"
          className="tnum text-heading font-semibold tracking-[-0.01em]"
          data-tone={tint}
          style={{ color: tint ? TONE_COLOR[tint] : 'var(--fg)' }}
        >
          {value}
        </span>
        {delta != null && (
          <span
            className="inline-flex items-center gap-[3px] text-micro"
            style={{ color: TONE_COLOR[tone] }}
          >
            {pulse && <Dot tone={TONE_DOT[tone]} size={5} pulse />}
            {delta}
          </span>
        )}
      </dd>
    </dl>
  )
}

/**
 * A wrapping row of stats with a hairline between neighbours (LIVE-8).
 *
 * `boxed` gives the one page-KPI container (DS-5): the sunken
 * `rounded-card border bg-bg-sunken px-4 py-3` box that Overview, Metrics,
 * Anomalies and Coverage each spelled out by hand. Leave it off for a strip
 * that already sits inside a panel or a header.
 *
 * The divider used to be a sibling element between two stats, so when the row
 * wrapped (375px, and 768px beside the sidebar) it stayed at the end of the
 * line with nothing after it ("COVERAGE 58.8% |"). Here every stat but the
 * first carries its own divider in the gap to its left, and the row clips a
 * few pixels outside its content box: a stat that starts a line has its
 * divider out in that clipped margin, so no line ever begins or ends with one.
 * The clip is horizontal only, so focus rings above and below stay whole.
 *
 * `className` / `style` style the outer box (border, background, padding);
 * falsy children are skipped, so a conditional stat needs no divider logic.
 */
export function MiniStatStrip({
  children,
  boxed = false,
  className,
  style,
}: {
  children: ReactNode
  boxed?: boolean
  className?: string
  style?: CSSProperties
}) {
  const items = Children.toArray(children)
  return (
    <div
      data-slot="mini-stat-strip"
      className={cn(boxed && 'rounded-card border border-border bg-bg-sunken px-4 py-3', className)}
      style={style}
    >
      {/* The clip box sits 4px outside the row, enough for a focus ring on a
          stat at the edge; the dividers sit 12px out, in the 24px gap. It
          clips sideways only: a divider only ever pokes out at the left, and a
          vertical clip cut the top and bottom of the focus ring of a stat that
          reaches past its row (the Metrics catalog's filter toggles). */}
      <div
        className="-m-1 p-1"
        data-slot="mini-stat-clip"
        style={{ overflowX: 'clip', overflowY: 'visible' }}
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          {items.map((item, index) => (
            <div key={index} className="relative flex min-w-0 items-center">
              {index > 0 && (
                <span
                  aria-hidden="true"
                  data-slot="mini-stat-divider"
                  className="absolute -left-3 top-1/2 h-6 w-px -translate-y-1/2"
                  style={{ background: 'var(--border)' }}
                />
              )}
              {item}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
