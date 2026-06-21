import { useMemo, useState, type ReactNode } from 'react'
import { Moon, Sliders, Sparkles, Sun, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  useTheme,
  type Accent,
  type ChartStyle,
  type Density,
} from '@/components/theme-provider'
import {
  TweaksPanelContext,
  type TweaksPanelContextValue,
} from '@/components/tweaks-panel-context'

const ACCENTS: { id: Accent; label: string; color: string }[] = [
  { id: 'teal', label: 'Teal', color: 'oklch(0.72 0.14 192)' },
  { id: 'violet', label: 'Violet', color: 'oklch(0.72 0.16 290)' },
  { id: 'lime', label: 'Lime', color: 'oklch(0.82 0.18 130)' },
  { id: 'amber', label: 'Amber', color: 'oklch(0.78 0.15 75)' },
  { id: 'rose', label: 'Rose', color: 'oklch(0.74 0.17 15)' },
]

export function TweaksPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const value = useMemo<TweaksPanelContextValue>(
    () => ({ open, setOpen }),
    [open],
  )
  return (
    <TweaksPanelContext.Provider value={value}>
      {children}
      <TweaksPanel open={open} onOpenChange={setOpen} />
    </TweaksPanelContext.Provider>
  )
}

function TweaksPanel({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (next: boolean) => void
}) {
  const { theme, setTheme, accent, setAccent, density, setDensity, chartStyle, setChartStyle } =
    useTheme()

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        aria-label="Open tweaks panel"
        className="fixed bottom-5 right-5 z-50 flex h-9 w-9 items-center justify-center rounded-full border shadow-md transition-colors hover:bg-[var(--surface-hover)]"
        style={{
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border-strong)',
          color: 'var(--accent)',
        }}
      >
        <Sliders className="h-4 w-4" aria-hidden="true" />
      </button>
    )
  }

  const resolvedTheme: 'dark' | 'light' =
    theme === 'system'
      ? typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme

  return (
    <div
      className="fixed bottom-5 right-5 z-50 w-[280px] overflow-hidden rounded-xl border shadow-lg"
      style={{
        background: 'var(--bg-elevated)',
        borderColor: 'var(--border-strong)',
      }}
    >
      <div
        className="flex items-center gap-2 border-b px-3.5 py-2.5"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <Sparkles className="h-3 w-3" style={{ color: 'var(--accent)' }} />
        <span className="text-[12.5px] font-semibold">Tweaks</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Close tweaks panel"
          className="p-0.5"
          style={{ color: 'var(--fg-subtle)' }}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="flex flex-col gap-3.5 p-3.5">
        <Group label="Theme">
          <Seg<'dark' | 'light'>
            value={resolvedTheme}
            onChange={(v) => setTheme(v)}
            options={[
              { v: 'dark', l: 'Dark', icon: <Moon className="h-3 w-3" /> },
              { v: 'light', l: 'Light', icon: <Sun className="h-3 w-3" /> },
            ]}
          />
        </Group>
        <Group label="Accent">
          <div className="flex gap-1.5">
            {ACCENTS.map((a) => (
              <button
                type="button"
                key={a.id}
                onClick={() => setAccent(a.id)}
                title={a.label}
                className="h-7 w-7 rounded-md"
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
        className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em]"
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
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: Opt<T>[]
}) {
  return (
    <div
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
            className={cn(
              'flex flex-1 items-center justify-center gap-1 rounded-[4px] px-2 py-[5px] text-[11.5px] font-medium transition-colors',
            )}
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
