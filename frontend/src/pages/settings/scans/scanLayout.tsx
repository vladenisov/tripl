import { useId, type ReactNode } from 'react'
import { Database } from 'lucide-react'
import type { DbType } from '@/types'
import { cn } from '@/lib/utils'

// The mockup keys SrcIcon off a platform kind (web/ios/...) the real model lacks.
// We key off the data source's db_type instead, using one warehouse glyph with a
// per-engine accent hue so different sources stay visually distinct.
const DB_HUE: Record<DbType, string> = {
  clickhouse: 'oklch(0.62 0.17 65)',
  postgres: 'oklch(0.62 0.12 240)',
  bigquery: 'oklch(0.62 0.16 290)',
  // Local demo synthetic warehouse — a distinct teal so it never reads as a
  // real engine.
  synthetic: 'oklch(0.62 0.13 175)',
}

export function SrcIcon({ dbType, size = 30 }: { dbType: DbType | null; size?: number }) {
  const bg = dbType ? DB_HUE[dbType] : 'var(--fg-faint)'
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg text-white"
      style={{ width: size, height: size, background: bg }}
    >
      <Database style={{ width: size * 0.5, height: size * 0.5 }} />
    </div>
  )
}

// ─── Panel (header + body) — matches the mockup's SurfPanel ───
export function SurfPanel({
  title,
  subtitle,
  right,
  children,
  className,
}: {
  title?: string
  subtitle?: string
  right?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn('overflow-hidden rounded-[10px] border', className)}
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      {(title || right) && (
        <header
          className="flex items-center gap-2.5 border-b px-4 py-3"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold" style={{ color: 'var(--fg)' }}>
              {title}
            </div>
            {subtitle && (
              <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--fg-subtle)' }}>
                {subtitle}
              </div>
            )}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  )
}

// ─── Key/value display row used in the Overview panels ───
export function KV({
  label,
  value,
  mono = false,
}: {
  label: string
  value: ReactNode
  mono?: boolean
}) {
  return (
    <div
      className="flex items-start gap-3.5 border-t px-4 py-2.5 first:border-t-0"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      <span className="w-[150px] shrink-0 text-xs" style={{ color: 'var(--fg-subtle)' }}>
        {label}
      </span>
      <span
        className={cn('min-w-0 flex-1 text-[12.5px]', mono && 'mono')}
        style={{ color: 'var(--fg)' }}
      >
        {value}
      </span>
    </div>
  )
}

// Placeholder for an empty value (the mockup's NONE token).
export function NoneTag() {
  return <span style={{ color: 'var(--fg-faint)' }}>none</span>
}

// ─── KPI / stat card ───
export function StatCard({
  label,
  value,
  title,
}: {
  label: string
  value: ReactNode
  /**
   * Hover text disambiguating what the number counts. Several scan cards share
   * a label ("Rows read") across counters with different populations, and the
   * label alone cannot carry that.
   */
  title?: string
}) {
  return (
    <div
      className="rounded-[10px] border px-3.5 py-3"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      title={title}
    >
      <div className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
        {label}
      </div>
      <div className="mono tnum mt-1 text-[18px] font-medium" style={{ color: 'var(--fg)' }}>
        {value}
      </div>
    </div>
  )
}

// ─── Page-style settings card (matches the mockup's SCard) ───
export function SCard({
  title,
  description,
  tone,
  children,
  footer,
}: {
  title: string
  description?: string
  tone?: 'danger'
  children?: ReactNode
  footer?: ReactNode
}) {
  const danger = tone === 'danger'
  const borderColor = danger
    ? 'color-mix(in oklab, var(--danger) 40%, var(--border))'
    : 'var(--border)'
  return (
    <section
      className="mb-5 overflow-hidden rounded-xl border"
      style={{ borderColor, background: 'var(--surface)' }}
    >
      {(title || description) && (
        <header
          className="flex items-start gap-3 border-b px-[18px] py-4"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="min-w-0 flex-1">
            <h3
              className="m-0 text-sm font-semibold"
              style={{ color: danger ? 'var(--danger)' : 'var(--fg)' }}
            >
              {title}
            </h3>
            {description && (
              <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--fg-subtle)' }}>
                {description}
              </p>
            )}
          </div>
        </header>
      )}
      {children}
      {footer && (
        <footer
          className="flex items-center gap-2.5 border-t px-[18px] py-3"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-sunken)' }}
        >
          {footer}
        </footer>
      )}
    </section>
  )
}

// ─── Field row inside an SCard body (label + hint left, control right) ───
export function Field({
  label,
  hint,
  id,
  children,
  last,
}: {
  label: string
  hint?: string
  /**
   * The id of the control this row's label names. `false` for any row whose
   * content is not a labelable element, where a `<label htmlFor>` can only
   * dangle: today the Base query row (a CodeMirror contenteditable carrying its
   * own `ariaLabel`), the Preview row (a button and an error, no control), and
   * the Lookback row in its no-time-column form (a sentence explaining why
   * there is nothing to set). Stated as a rule rather than a list because
   * tripl-otlv fixed the first two by name and tripl-6h2b then found the third.
   * Same escape hatch as the settings kit's Field (components/settings/kit.tsx).
   */
  id?: string | false
  children: ReactNode
  last?: boolean
}) {
  const generatedId = useId()
  // `false` names the row as a group instead, so what it does hold is still
  // announced under "Base query" / "Preview" rather than under nothing.
  const captionId = id === false ? generatedId : undefined
  const controlId = id === false ? undefined : id
  return (
    <div
      role={captionId ? 'group' : undefined}
      aria-labelledby={captionId}
      className={cn('flex items-start gap-6 px-[18px] py-4', !last && 'border-b')}
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      <div className="w-[232px] shrink-0 pt-1.5">
        {captionId ? (
          <span id={captionId} className="block text-[13px] font-medium" style={{ color: 'var(--fg)' }}>
            {label}
          </span>
        ) : (
          <label htmlFor={controlId} className="block text-[13px] font-medium" style={{ color: 'var(--fg)' }}>
            {label}
          </label>
        )}
        {hint && (
          <div className="mt-1 text-xs leading-snug" style={{ color: 'var(--fg-subtle)' }}>
            {hint}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

// Back link used on detail / create surfaces.
export function BackLink({ onClick, label = 'Scans' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-[11.5px] transition-colors"
      style={{ color: 'var(--fg-muted)' }}
    >
      <span aria-hidden>←</span> {label}
    </button>
  )
}
