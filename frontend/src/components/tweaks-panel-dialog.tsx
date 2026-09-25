import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Monitor, Moon, Sparkles, Sun, X } from 'lucide-react'
import {
  useTheme,
  type Accent,
  type ChartStyle,
  type Density,
  type Theme,
} from '@/components/theme-provider'
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control'

// No colour values here: each swatch carries its accent's class, so it paints
// `--accent` exactly as that accent resolves in the current theme. Hard-coded
// dark tones used to preview colours the light theme never shows (DS-19 /
// SH-24), and drifted from index.css whenever a hue moved.
const ACCENTS: { id: Accent; label: string }[] = [
  { id: 'teal', label: 'Teal' },
  { id: 'violet', label: 'Violet' },
  { id: 'lime', label: 'Lime' },
  { id: 'indigo', label: 'Indigo' },
  { id: 'magenta', label: 'Magenta' },
]

const THEME_OPTIONS: SegmentedOption<Theme>[] = [
  { value: 'system', label: <><Monitor className="size-3" aria-hidden="true" />System</> },
  { value: 'dark', label: <><Moon className="size-3" aria-hidden="true" />Dark</> },
  { value: 'light', label: <><Sun className="size-3" aria-hidden="true" />Light</> },
]

const DENSITY_OPTIONS: SegmentedOption<Density>[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'cozy', label: 'Cozy' },
  { value: 'comfy', label: 'Comfy' },
]

const CHART_STYLE_OPTIONS: SegmentedOption<ChartStyle>[] = [
  { value: 'line', label: 'Line' },
  { value: 'line-only', label: 'Stroke' },
  { value: 'bar', label: 'Bars' },
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
          className="rounded-sm p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{ color: 'var(--fg-subtle)' }}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="flex flex-col gap-3.5 p-3.5">
        <Group label="Theme">
          {/* "System" is a choice of its own: offering only the two resolved
              values overwrote it for good on the first click (SHELL-33). */}
          <PanelSeg<Theme>
            label="Theme"
            value={theme}
            onChange={(v) => setTheme(v)}
            options={THEME_OPTIONS}
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
                className={`accent-${a.id} h-7 w-7 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]`}
                style={{
                  background: 'var(--accent)',
                  border:
                    accent === a.id
                      ? '2px solid var(--fg)'
                      : '2px solid transparent',
                  outline: '1px solid var(--border)',
                }}
              />
            ))}
          </div>
          {/* The swatches carry no text, so the choice is named under them. */}
          <div className="mt-1.5 text-caption" style={{ color: 'var(--fg-muted)' }} aria-hidden="true">
            {ACCENTS.find((a) => a.id === accent)?.label}
          </div>
        </Group>
        <Group label="Density">
          <PanelSeg<Density>
            label="Density"
            value={density}
            onChange={(v) => setDensity(v)}
            options={DENSITY_OPTIONS}
          />
        </Group>
        <Group label="Chart style">
          <PanelSeg<ChartStyle>
            label="Chart style"
            value={chartStyle}
            onChange={(v) => setChartStyle(v)}
            options={CHART_STYLE_OPTIONS}
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
        className="micro-label mb-1.5"
        style={{ color: 'var(--fg-subtle)' }}
      >
        {label}
      </div>
      {children}
    </div>
  )
}

/**
 * The shared SegmentedControl (DS-16), stretched to the panel width with its
 * options sharing it equally. It replaces a hand-rolled copy of the same look.
 */
function PanelSeg<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: T
  onChange: (v: T) => void
  options: ReadonlyArray<SegmentedOption<T>>
}) {
  return (
    <SegmentedControl<T>
      aria-label={label}
      size="sm"
      value={value}
      onChange={onChange}
      options={options}
      className="flex w-full [&>button]:flex-1"
    />
  )
}
