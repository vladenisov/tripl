import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp } from 'lucide-react'

import { metricsApi } from '@/api/metrics'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface TopMoversPanelProps {
  slug: string
  scanConfigId: string
  scopeType: string
  scopeRef: string
  bucket: string
  limit?: number
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString()
}

function percentDelta(actual: number, expected: number): string {
  if (expected <= 0) return ''
  const pct = ((actual - expected) / expected) * 100
  if (Math.abs(pct) < 0.5) return ''
  return `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`
}

export function TopMoversPanel({
  slug,
  scanConfigId,
  scopeType,
  scopeRef,
  bucket,
  limit = 8,
}: TopMoversPanelProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['topMovers', slug, scanConfigId, scopeType, scopeRef, bucket, limit],
    queryFn: () =>
      metricsApi.getTopMovers(slug, scanConfigId, {
        scope_type: scopeType,
        scope_ref: scopeRef,
        bucket,
        limit,
      }),
    enabled: Boolean(slug && scanConfigId && scopeRef && bucket),
  })

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Loading top movers…
        </CardContent>
      </Card>
    )
  }

  if (isError || !data || data.length === 0) {
    return null
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div>
          <h2 className="text-sm font-semibold">Top movers</h2>
          <p className="text-xs text-muted-foreground">
            Breakdown rows ranked by |z|, for this anomaly bucket.
          </p>
        </div>
        <ul className="divide-y divide-border text-sm">
          {data.map(item => {
            const delta = item.actual_count - item.expected_count
            const pct = percentDelta(item.actual_count, item.expected_count)
            const Icon = item.direction === 'spike' ? ArrowUp : ArrowDown
            return (
              <li
                key={`${item.breakdown_column}:${item.breakdown_value}:${item.is_other}`}
                className="flex items-center justify-between gap-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    <span className="text-muted-foreground">{item.breakdown_column}=</span>
                    <span className="font-mono">
                      {item.is_other ? '(other)' : item.breakdown_value}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    actual {formatCount(item.actual_count)} · expected {formatCount(item.expected_count)}
                  </p>
                </div>
                <div className="flex items-center gap-2 whitespace-nowrap text-right text-xs">
                  <span
                    className={cn(
                      'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium',
                      item.direction === 'spike'
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                        : 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
                    )}
                  >
                    <Icon className="h-3 w-3" />
                    {delta > 0 ? '+' : ''}{formatCount(delta)}
                  </span>
                  {pct && <span className="text-muted-foreground">{pct}</span>}
                  <span className="font-mono text-muted-foreground">
                    z={item.z_score.toFixed(1)}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
