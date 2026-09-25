import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Monitor, Moon, Sparkles, Sun, X } from 'lucide-react'
import {
  useTheme,
  type Accent,
  type ChartStyle,
  type Density,
  type Theme,
} from '@/components/theme-provider'

const ACCENTS: { id: Accent; label: string; color: string }[] = [
  { id: 'teal', label: 'Teal', color: 'oklch(0.72 0.14 192)' },
  { id: 'violet', label: 'Violet', color: 'oklch(0.72 0.16 290)' },
  { id: 'lime', label: 'Lime', color: 'oklch(0.82 0.18 130)' },
  { id: 'amber', label: 'Amber', color: 'oklch(0.78 0.15 75)' },
  { id: 'rose', label: 'Rose', color: 'oklch(0.74 0.17 15)' },
]

/**
 * Appearance settings: theme, accent, density, chart style.
 *
 * Opened from the sidebar's account controls. It used to be reached from a disc
 * fixed over the bottom-right of every page — over table rows, sticky form
 * actions and pagination on a phone (SHELL-35 / LIVE-33). It behaves like the
 * popover it is: focus moves in, Escape or a click outside closes it, and focus
 * returns to the control that opened it.
 */
export function TweaksPanel({ onClose }: { onClose: () => void }) {
  const { theme, setTheme, accent, setAccent, density, setDensity, chartStyle, setChartStyle } =
    useTheme()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('button')?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [onClose])

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-labelledby={titleId}
      // Beside the sidebar footer that opens it, above the iOS home indicator.
      // On the drawer layer, under modals: at z-50 this non-modal panel sat on
      // top of an open dialog's overlay (DS-40).
      className="fixed bottom-[calc(0.75rem+env(safe-area-inset-bottom))] left-3 z-(--z-drawer) w-[min(280px,calc(100vw-24px))] overflow-hidden rounded-xl border shadow-lg"
      style={{
        background: 'var(--bg-elevated)',
        borderColor: 'var(--border-strong)',
      }}
    >
      <div
        className="flex items-center gap-2 border-b px-3.5 py-2.5"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <Sparkles className="h-3 w-3" style={{ color: 'var(--accent)' }} aria-hidden="true" />
        <span id={titleId} className="text-body-sm font-semibold">
          Appearance
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close appearance settings"
          className="rounded p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{ color: 'var(--fg-subtle)' }}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="flex flex-col gap-3.5 p-3.5">
        <Group label="Theme">
          {/* "System" is a choice of its own: offering only the two resolved
              values overwrote it for good on the first click (SHELL-33). */}
          <Seg<Theme>
            label="Theme"
            value={theme}
            onChange={(v) => setTheme(v)}
            options={[
              { v: 'system', l: 'System', icon: <Monitor className="h-3 w-3" aria-hidden="true" /> },
              { v: 'dark', l: 'Dark', icon: <Moon className="h-3 w-3" aria-hidden="true" /> },
              { v: 'light', l: 'Light', icon: <Sun className="h-3 w-3" aria-hidden="true" /> },
            ]}
          />
        </Group>
        <Group label="Accent">
          <div role="group" aria-label="Accent" className="flex gap-1.5">
            {ACCENTS.map((a) => (
              <button
                type="button"
                key={a.id}
                onClick={() => setAccent(a.id)}
                title={a.label}
                aria-label={a.label}
                aria-pressed={accent === a.id}
                className="h-7 w-7 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                style={{
                  background: a.color,
                  border:
                    accent === a.id
                      ? '2px solid var(--fg)'
                      : '2px solid transparent',
                  outline: '1px solid var(--border)',
                }}
              />
            ))}
          </div>
        </Group>
        <Group label="Density">
          <Seg<Density>
            label="Density"
            value={density}
            onChange={(v) => setDensity(v)}
            options={[
              { v: 'compact', l: 'Compact' },
              { v: 'cozy', l: 'Cozy' },
              { v: 'comfy', l: 'Comfy' },
            ]}
          />
        </Group>
        <Group label="Chart style">
          <Seg<ChartStyle>
            label="Chart style"
            value={chartStyle}
            onChange={(v) => setChartStyle(v)}
            options={[
              { v: 'line', l: 'Line' },
              { v: 'line-only', l: 'Stroke' },
              { v: 'bar', l: 'Bars' },
            ]}
          />
        </Group>
      </div>
    </div>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div
        className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.06em]"
        style={{ color: 'var(--fg-subtle)' }}
      >
        {label}
      </div>
      {children}
    </div>
  )
}

type Opt<T extends string> = { v: T; l: string; icon?: ReactNode }

function Seg<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: T
  onChange: (v: T) => void
  options: Opt<T>[]
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex rounded-md border p-0.5"
      style={{
        background: 'var(--bg-sunken)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {options.map((o) => {
        const active = value === o.v
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            aria-pressed={active}
            className="flex flex-1 items-center justify-center gap-1 rounded-[4px] px-2 py-[5px] text-caption font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            style={{
              background: active ? 'var(--surface)' : 'transparent',
              color: active ? 'var(--fg)' : 'var(--fg-muted)',
              boxShadow: active ? 'var(--shadow-sm)' : 'none',
            }}
          >
            {o.icon}
            {o.l}
          </button>
        )
      })}
    </div>
  )
}
