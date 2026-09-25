import { type ReactNode } from 'react'
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
        className={cn('min-w-0 flex-1 text-body-sm', mono && 'mono')}
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
      className="rounded-card border px-3.5 py-3"
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
              <p className="mt-1 text-body-sm leading-relaxed" style={{ color: 'var(--fg-subtle)' }}>
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


// Back link used on detail / create surfaces.
export function BackLink({ onClick, label = 'Scans' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-caption transition-colors"
      style={{ color: 'var(--fg-muted)' }}
    >
      <span aria-hidden>←</span> {label}
    </button>
  )
}
