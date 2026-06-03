import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { metricsApi } from '@/api/metrics'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

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

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
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
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-[10px]">
            <thead>
              <tr>
                <th className="w-10" />
                {HOURS_FULL.map(hour => (
                  <th
                    key={hour}
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
                  <td className="pr-2 text-right text-muted-foreground">{label}</td>
                  {HOURS_FULL.map(hour => {
                    const key = `${weekday}:${hour}`
                    const cell = cellsByKey.get(key)
                    const count = cell?.count ?? 0
                    const intensity = data.max_count === 0 ? 0 : count / data.max_count
                    const hasAnomaly = (cell?.anomaly_count ?? 0) > 0
                    return (
                      <td
                        key={hour}
                        className="p-[1px]"
                        title={`${label} ${hour.toString().padStart(2, '0')}:00 — ${formatCount(count)} events${
                          hasAnomaly ? ` · ${cell?.anomaly_count} anomaly bucket(s)` : ''
                        }`}
                      >
                        <div
                          className={cn(
                            'h-6 w-full rounded-sm',
                            hasAnomaly && 'ring-1 ring-destructive',
                          )}
                          style={{
                            backgroundColor: color,
                            opacity: 0.12 + 0.78 * intensity,
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
