import type { ReactNode } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import type { VariableRetirementCounts } from '@/api/projects'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/settings/kit'
import { RESET_PERIODS } from './projectGeneralFields'

/** The danger-zone rows of Project settings › General. */

/**
 * A settings row with text on the left and an action group on the right, which
 * stacks below `sm`. Side by side at 375px, a period Select (up to 280px) plus
 * a button left the text a few characters wide and pushed the row past the
 * card (WS-14) — the kit's Field switches to a column there for the same reason.
 */
export const DANGER_ROW_CLASS =
  'flex flex-col gap-3 px-[18px] py-[14px] sm:flex-row sm:items-center sm:gap-[18px]'

export function DangerRow({
  title,
  hint,
  action,
  last,
}: {
  title: string
  hint: string
  action: ReactNode
  last?: boolean
}) {
  return (
    <div
      className={DANGER_ROW_CLASS}
      style={{ borderBottom: last ? 'none' : '1px solid var(--border-subtle)' }}
    >
      <div className="min-w-0 flex-1">
        <div className="text-body font-medium">{title}</div>
        <div className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: 'var(--fg-subtle)' }}>
          {hint}
        </div>
      </div>
      {action}
    </div>
  )
}

/**
 * A danger-zone row that clears a category of detections over a chosen period.
 * The period selector sits next to a destructive button; confirmation and the
 * mutation are owned by the caller. Feedback (counts / error) renders under it.
 */
export function DangerResetRow({
  title,
  hint,
  buttonLabel,
  period,
  onPeriodChange,
  onReset,
  busy,
  feedback,
}: {
  title: string
  hint: string
  buttonLabel: string
  period: string
  onPeriodChange: (value: string) => void
  onReset: () => void
  busy: boolean
  feedback: ReactNode
}) {
  return (
    <div
      className={DANGER_ROW_CLASS}
      style={{ borderBottom: '1px solid var(--border-subtle)' }}
    >
      <div className="min-w-0 flex-1">
        <div className="text-body font-medium">{title}</div>
        <div className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: 'var(--fg-subtle)' }}>
          {hint}
        </div>
        {feedback}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          aria-label={`${title} period`}
          value={period}
          onChange={onPeriodChange}
          options={RESET_PERIODS}
          disabled={busy}
        />
        <Button variant="destructive" size="sm" disabled={busy} onClick={onReset}>
          <RotateCcw className="h-3 w-3" />
          {busy ? 'Resetting…' : buttonLabel}
        </Button>
      </div>
    </div>
  )
}

/**
 * The retirement row is two buttons, not one: a preview that commits nothing,
 * and a destructive apply that only lights up once the preview has said how
 * many rows it would take. Scans mint variables and, before this shipped, never
 * retired one, so a project can arrive here carrying four figures of them — the
 * count IS the decision, and asking for it separately is what makes the second
 * click informed rather than brave.
 */
export function DangerRetireVariablesRow({
  onPreview,
  onRetire,
  busy,
  preview,
  feedback,
}: {
  onPreview: () => void
  onRetire: () => void
  busy: boolean
  preview: VariableRetirementCounts | undefined
  feedback: ReactNode
}) {
  return (
    <div
      className={DANGER_ROW_CLASS}
      style={{ borderBottom: '1px solid var(--border-subtle)' }}
    >
      <div className="min-w-0 flex-1">
        <div className="text-body font-medium">Retire unused variables</div>
        <div className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: 'var(--fg-subtle)' }}>
          Delete variables a scan created that no event field value references and that carry no
          observed values, drift or documented values. Nothing edited by hand is touched.
        </div>
        {feedback}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={onPreview}>
          {busy ? 'Checking…' : 'Preview'}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={busy || !preview || preview.retirable === 0}
          onClick={onRetire}
        >
          <Trash2 className="h-3 w-3" />
          Retire
        </Button>
      </div>
    </div>
  )
}
