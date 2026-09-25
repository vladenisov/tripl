import type { ReactNode } from 'react'
import { Dot, type DotTone } from '@/components/primitives/dot'

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

export function MiniStat({
  label,
  value,
  delta,
  tone = 'neutral',
  valueTone,
  pulse = false,
}: MiniStatProps) {
  // A definition list programmatically ties the value (<dd>) to its caption
  // (<dt>) so assistive tech announces "<label>: <value>" together, instead of
  // two unrelated <span>s. (Issue M9.)
  const figureTone = valueTone ?? (delta == null ? tone : undefined)
  const tint = figureTone && figureTone !== 'neutral' ? figureTone : undefined
  return (
    <dl className="m-0 flex flex-col gap-px">
      <dt
        className="text-[10px] font-semibold uppercase tracking-[0.06em]"
        style={{ color: 'var(--fg-faint)' }}
      >
        {label}
      </dt>
      <dd className="m-0 flex items-baseline gap-1.5">
        <span
          className="mono tnum text-[16px] font-medium tracking-[-0.01em]"
          data-tone={tint}
          style={{ color: tint ? TONE_COLOR[tint] : 'var(--fg)' }}
        >
          {value}
        </span>
        {delta != null && (
          <span
            className="inline-flex items-center gap-[3px] text-[10.5px]"
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

export function MiniStatDivider() {
  return <div className="h-6 w-px" style={{ background: 'var(--border)' }} />
}
