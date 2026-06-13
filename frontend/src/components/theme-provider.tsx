import { createContext, useContext, useEffect, useState } from "react"

type Theme = "dark" | "light" | "system"
export type Accent = "teal" | "violet" | "lime" | "amber" | "rose"
export type Density = "compact" | "cozy" | "comfy"
export type ChartStyle = "line" | "line-only" | "bar"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  defaultAccent?: Accent
  defaultDensity?: Density
  defaultChartStyle?: ChartStyle
  storageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  accent: Accent
  density: Density
  chartStyle: ChartStyle
  setTheme: (theme: Theme) => void
  setAccent: (accent: Accent) => void
  setDensity: (density: Density) => void
  setChartStyle: (chartStyle: ChartStyle) => void
}

const initialState: ThemeProviderState = {
  theme: "system",
  accent: "teal",
  density: "compact",
  chartStyle: "line",
  setTheme: () => null,
  setAccent: () => null,
  setDensity: () => null,
  setChartStyle: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

const ACCENTS: Accent[] = ["teal", "violet", "lime", "amber", "rose"]
const DENSITIES: Density[] = ["compact", "cozy", "comfy"]
const CHART_STYLES: ChartStyle[] = ["line", "line-only", "bar"]

function readLocal<T extends string>(key: string, valid: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key)
    if (value && (valid as readonly string[]).includes(value)) return value as T
  } catch {
    /* ignore */
  }
  return fallback
}

export function ThemeProvider({
  children,
  defaultTheme = "dark",
  defaultAccent = "teal",
  defaultDensity = "compact",
  defaultChartStyle = "line",
  storageKey = "tripl-ui-theme",
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() =>
    readLocal<Theme>(storageKey, ["dark", "light", "system"], defaultTheme),
  )
  const [accent, setAccentState] = useState<Accent>(() =>
    readLocal<Accent>(`${storageKey}-accent`, ACCENTS, defaultAccent),
  )
  const [density, setDensityState] = useState<Density>(() =>
    readLocal<Density>(`${storageKey}-density`, DENSITIES, defaultDensity),
  )
  const [chartStyle, setChartStyleState] = useState<ChartStyle>(() =>
    readLocal<ChartStyle>(`${storageKey}-chart`, CHART_STYLES, defaultChartStyle),
  )

  useEffect(() => {
    const root = window.document.documentElement
    root.classList.remove("light", "dark")

    if (theme === "system") {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      root.classList.add(systemTheme)
      return
    }

    root.classList.add(theme)
  }, [theme])

  useEffect(() => {
    const root = window.document.documentElement
    ACCENTS.forEach((a) => root.classList.remove(`accent-${a}`))
    root.classList.add(`accent-${accent}`)
  }, [accent])

  useEffect(() => {
    const root = window.document.documentElement
    DENSITIES.forEach((d) => root.classList.remove(`density-${d}`))
    root.classList.add(`density-${density}`)
  }, [density])

  const value: ThemeProviderState = {
    theme,
    accent,
    density,
    chartStyle,
    setTheme: (next) => {
      try { localStorage.setItem(storageKey, next) } catch { /* ignore */ }
      setThemeState(next)
    },
    setAccent: (next) => {
      try { localStorage.setItem(`${storageKey}-accent`, next) } catch { /* ignore */ }
      setAccentState(next)
    },
    setDensity: (next) => {
      try { localStorage.setItem(`${storageKey}-density`, next) } catch { /* ignore */ }
      setDensityState(next)
    },
    setChartStyle: (next) => {
      try { localStorage.setItem(`${storageKey}-chart`, next) } catch { /* ignore */ }
      setChartStyleState(next)
    },
  }

  return (
    <ThemeProviderContext value={value}>
      {children}
    </ThemeProviderContext>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useTheme = () => {
  const context = useContext(ThemeProviderContext)
  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider")
  return context
}
