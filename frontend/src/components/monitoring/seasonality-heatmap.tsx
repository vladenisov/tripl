import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { metricsApi } from '@/api/metrics'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { SeasonalityCell } from '@/types/metrics'

interface SeasonalityHeatmapProps {
  slug: string
  scanConfigId: string
  scopeType: string
  scopeRef: string
  from: string
  to: string
  color?: string
}

const WEEKDAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const HOURS_FULL = Array.from({ length: 24 }, (_, hour) => hour)
// Show every 3rd hour as an axis label so labels don't overlap on narrow viewports.
const HOUR_LABEL_EVERY = 3
// Empty slots stay faintly tinted so the grid structure reads, while active slots
// ramp across a wide opacity band so real variance (not just the single peak) shows.
const EMPTY_OPACITY = 0.06
const MIN_FILL_OPACITY = 0.18
const MAX_FILL_OPACITY = 0.96
// Discrete stops used to paint the legend gradient bar.
const LEGEND_STOPS = [0, 0.25, 0.5, 0.75, 1] as const

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function fillOpacity(intensity: number): number {
  return MIN_FILL_OPACITY + (MAX_FILL_OPACITY - MIN_FILL_OPACITY) * intensity
}

function slotLabel(weekday: number, hour: number): string {
  const day = WEEKDAYS_SHORT[weekday] ?? `Day ${weekday}`
  return `${day} ${hour.toString().padStart(2, '0')}:00`
}

interface HeatScale {
  opacityFor: (count: number) => number
  minCount: number
  maxCount: number
  busiest: SeasonalityCell | null
  quietest: SeasonalityCell | null
}

// Rank active cells into quantile buckets so a ~4x volume swing spreads across the
// full luminance ramp instead of collapsing into a near-uniform block — which is
// what a plain count / max_count ratio does when the distribution is skewed.
function buildScale(cells: SeasonalityCell[]): HeatScale {
  const active = cells.filter(cell => cell.count > 0)
  const uniqueSorted = Array.from(new Set(active.map(cell => cell.count))).sort(
    (a, b) => a - b,
  )
  const rankByCount = new Map<number, number>()
  uniqueSorted.forEach((count, index) => {
    const intensity = uniqueSorted.length <= 1 ? 1 : index / (uniqueSorted.length - 1)
    rankByCount.set(count, intensity)
  })

  let busiest: SeasonalityCell | null = null
  let quietest: SeasonalityCell | null = null
  for (const cell of active) {
    if (!busiest || cell.count > busiest.count) busiest = cell
    if (!quietest || cell.count < quietest.count) quietest = cell
  }

  return {
    opacityFor: count =>
      count > 0 ? fillOpacity(rankByCount.get(count) ?? 0) : EMPTY_OPACITY,
    minCount: uniqueSorted[0] ?? 0,
    maxCount: uniqueSorted[uniqueSorted.length - 1] ?? 0,
    busiest,
    quietest,
  }
}

export function SeasonalityHeatmap({
  slug,
  scanConfigId,
  scopeType,
  scopeRef,
  from,
  to,
  color = 'var(--chart-1)',
}: SeasonalityHeatmapProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['seasonality', slug, scanConfigId, scopeType, scopeRef, from, to],
    queryFn: () =>
      metricsApi.getSeasonalityHeatmap(slug, scanConfigId, {
        scope_type: scopeType,
        scope_ref: scopeRef,
        from,
        to,
      }),
    enabled: Boolean(slug && scanConfigId && scopeRef),
  })

  const cellsByKey = useMemo(() => {
    const map = new Map<string, { count: number; anomaly_count: number }>()
    for (const cell of data?.cells ?? []) {
      map.set(`${cell.weekday}:${cell.hour}`, {
        count: cell.count,
        anomaly_count: cell.anomaly_count,
      })
    }
    return map
  }, [data?.cells])

  const scale = useMemo(() => buildScale(data?.cells ?? []), [data?.cells])

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Loading heatmap…
        </CardContent>
      </Card>
    )
  }

  if (isError || !data || data.max_count === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Not enough data to build a seasonality heatmap for this scope yet.
        </CardContent>
      </Card>
    )
  }

  const { busiest, quietest } = scale
  const gridSummary =
    busiest && quietest
      ? `Volume by weekday and hour. Busiest slot ${slotLabel(busiest.weekday, busiest.hour)} with ${busiest.count.toLocaleString()} events; quietest active slot ${slotLabel(quietest.weekday, quietest.hour)} with ${quietest.count.toLocaleString()} events.`
      : 'Volume by weekday and hour.'

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div>
          <h2 className="text-sm font-semibold">Hour × weekday heatmap</h2>
          <p className="text-xs text-muted-foreground">
            Total volume by day-of-week and hour-of-day. Red ring marks slots with
            detected anomalies. Total in window:{' '}
            <span className="font-medium">{formatCount(data.total_count)}</span>.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="tabular-nums">{formatCount(scale.minCount)}</span>
          <div
            className="flex h-2 w-24 overflow-hidden rounded-sm ring-1 ring-border/60"
            aria-hidden="true"
          >
            {LEGEND_STOPS.map(stop => (
              <div
                key={stop}
                className="h-full flex-1"
                style={{ backgroundColor: color, opacity: fillOpacity(stop) }}
              />
            ))}
          </div>
          <span className="tabular-nums">{formatCount(scale.maxCount)}</span>
          <span className="ml-0.5">events / slot</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-[10px]">
            <caption className="sr-only">{gridSummary}</caption>
            <thead>
              <tr>
                <th className="w-10" />
                {HOURS_FULL.map(hour => (
                  <th
                    key={hour}
                    scope="col"
                    className="px-0 pb-1 text-center font-normal text-muted-foreground"
                  >
                    {hour % HOUR_LABEL_EVERY === 0 ? hour.toString().padStart(2, '0') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WEEKDAYS_SHORT.map((label, weekday) => (
                <tr key={label}>
                  <th scope="row" className="pr-2 text-right font-normal text-muted-foreground">{label}</th>
                  {HOURS_FULL.map(hour => {
                    const key = `${weekday}:${hour}`
                    const cell = cellsByKey.get(key)
                    const count = cell?.count ?? 0
                    const anomalyCount = cell?.anomaly_count ?? 0
                    const hasAnomaly = anomalyCount > 0
                    const tooltipText = `${slotLabel(weekday, hour)} — ${count.toLocaleString()} events${
                      hasAnomaly ? ` · ${anomalyCount} anomaly bucket(s)` : ''
                    }`
                    return (
                      <td
                        key={hour}
                        className="p-[1px]"
                        title={tooltipText}
                      >
                        <span className="sr-only">{tooltipText}</span>
                        <div
                          data-count={count}
                          className={cn(
                            'h-6 w-full rounded-sm',
                            hasAnomaly && 'ring-1 ring-destructive',
                          )}
                          style={{
                            backgroundColor: color,
                            opacity: scale.opacityFor(count),
                          }}
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
