import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from 'lucide-react'
import { Area, ComposedChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'

import { metricsApi } from '@/api/metrics'
import { Card, CardContent } from '@/components/ui/card'
import { CHART_SURFACE_TAB_INDEX } from '@/components/ui/chart-format'
import { formatSignalSeverity } from '@/lib/monitoring'
import { NO_BASELINE_LABEL, formatRatioDelta, ratioDelta } from '@/lib/percentDelta'
import { cn } from '@/lib/utils'
import type { TopMoverItem } from '@/types'

interface TopMoversPanelProps {
  slug: string
  scanConfigId: string
  scopeType: string
  scopeRef: string
  bucket: string
  limit?: number
  from?: string
  to?: string
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString()
}

/**
 * What the chip beside a top-mover row says: a signed percentage, the words
 * `no baseline`, or '' when there is genuinely nothing to add.
 *
 * Two cases used to share the empty string and so looked identical in the row:
 * a real change too small to round to a whole percent, and a breakdown value
 * with no baseline at all. Only the first is genuinely nothing to say — the
 * signed absolute-delta badge next to this chip already carries it. The second
 * is a fact, and one the detector admits on purpose (a brand-new breakdown value
 * whose median expectation is 0 passes `min_expected_count` at its floor), so it
 * is named rather than left as a gap in a column every other row fills
 * (tripl-l429.27).
 */
function percentDelta(actual: number, expected: number): string {
  const pct = ratioDelta(actual, expected)
  if (pct === null) return NO_BASELINE_LABEL
  if (Math.abs(pct) < 0.5) return ''
  return formatRatioDelta(pct)
}

export function TopMoversPanel({
  slug,
  scanConfigId,
  scopeType,
  scopeRef,
  bucket,
  limit = 8,
  from,
  to,
}: TopMoversPanelProps) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
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
            Breakdown rows ranked by |z|, for this anomaly bucket. Click a row to
            see its timeline.
          </p>
        </div>
        <ul className="divide-y divide-border text-sm">
          {data.map(item => {
            const rowKey = `${item.breakdown_column}:${item.breakdown_value}:${item.is_other}`
            const isExpanded = expandedKey === rowKey
            return (
              <li key={rowKey}>
                <TopMoverRow
                  item={item}
                  isExpanded={isExpanded}
                  onToggle={() => setExpandedKey(prev => (prev === rowKey ? null : rowKey))}
                />
                {isExpanded && (
                  <BreakdownDrilldown
                    slug={slug}
                    scanConfigId={scanConfigId}
                    scopeType={scopeType}
                    scopeRef={scopeRef}
                    breakdownColumn={item.breakdown_column}
                    breakdownValue={item.breakdown_value}
                    isOther={item.is_other}
                    from={from}
                    to={to}
                  />
                )}
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}

function TopMoverRow({
  item,
  isExpanded,
  onToggle,
}: {
  item: TopMoverItem
  isExpanded: boolean
  onToggle: () => void
}) {
  const delta = item.actual_count - item.expected_count
  const pct = percentDelta(item.actual_count, item.expected_count)
  const Icon = item.direction === 'spike' ? ArrowUp : ArrowDown
  const ChevronIcon = isExpanded ? ChevronDown : ChevronRight

  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-3 py-2 text-left transition-colors hover:bg-muted/40"
      aria-expanded={isExpanded}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ChevronIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
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
      </div>
      <div className="flex items-center gap-2 whitespace-nowrap text-right text-xs">
        <span
          className={cn(
            'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium',
            item.direction === 'spike'
              ? 'bg-success-soft text-success'
              : 'bg-danger-soft text-danger',
          )}
        >
          <Icon aria-hidden="true" className="h-3 w-3" />
          {delta > 0 ? '+' : ''}{formatCount(delta)}
        </span>
        {pct && (
          <span
            className="text-muted-foreground"
            title={
              item.expected_count > 0
                ? undefined
                : 'No baseline to compare against for this breakdown value'
            }
          >
            {pct}
          </span>
        )}
        <span className="font-mono text-muted-foreground">
          {formatSignalSeverity(item)}
        </span>
      </div>
    </button>
  )
}

function BreakdownDrilldown({
  slug,
  scanConfigId,
  scopeType,
  scopeRef,
  breakdownColumn,
  breakdownValue,
  isOther,
  from,
  to,
}: {
  slug: string
  scanConfigId: string
  scopeType: string
  scopeRef: string
  breakdownColumn: string
  breakdownValue: string
  isOther: boolean
  from?: string
  to?: string
}) {
  const { data, isLoading } = useQuery({
    queryKey: [
      'breakdownTimeline',
      slug,
      scanConfigId,
      scopeType,
      scopeRef,
      breakdownColumn,
      breakdownValue,
      isOther,
      from,
      to,
    ],
    queryFn: () =>
      metricsApi.getBreakdownTimeline(slug, scanConfigId, {
        scope_type: scopeType,
        scope_ref: scopeRef,
        breakdown_column: breakdownColumn,
        breakdown_value: breakdownValue,
        is_other: isOther,
        from,
        to,
      }),
  })

  if (isLoading) {
    return (
      <div className="px-2 pb-3 pt-1 text-xs text-muted-foreground" data-testid="breakdown-drilldown">
        Loading timeline…
      </div>
    )
  }

  const points = data?.data ?? []
  if (points.length === 0) {
    return (
      <div className="px-2 pb-3 pt-1 text-xs text-muted-foreground" data-testid="breakdown-drilldown">
        No timeline data for this breakdown value yet.
      </div>
    )
  }

  return (
    <div className="px-2 pb-3 pt-1" data-testid="breakdown-drilldown">
      <div
        role="img"
        aria-label={`Timeline for ${breakdownColumn}=${isOther ? '(other)' : breakdownValue}`}
        className="h-[120px] w-full"
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={points}
            margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
            tabIndex={CHART_SURFACE_TAB_INDEX}
          >
            <XAxis
              dataKey="bucket"
              hide
            />
            <YAxis
              hide
              domain={['auto', 'auto']}
            />
            <Area
              type="monotone"
              dataKey="count"
              stroke="var(--chart-2)"
              fill="var(--chart-2)"
              fillOpacity={0.15}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
