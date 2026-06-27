import type { ReactNode } from 'react'
import { Dot, type DotTone } from '@/components/primitives/dot'

export type MiniStatTone = 'success' | 'danger' | 'warning' | 'info' | 'accent' | 'neutral'

type MiniStatProps = {
  label: string
  value: ReactNode
  delta?: ReactNode
  tone?: MiniStatTone
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

export function MiniStat({ label, value, delta, tone = 'neutral', pulse = false }: MiniStatProps) {
  // A definition list programmatically ties the value (<dd>) to its caption
  // (<dt>) so assistive tech announces "<label>: <value>" together, instead of
  // two unrelated <span>s. (Issue M9.)
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
          style={{ color: 'var(--fg)' }}
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
