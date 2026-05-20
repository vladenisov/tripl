import { useId, useMemo } from 'react'
import {
  Area,
  Bar,
  ComposedChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { cn } from '@/lib/utils'
import type { MetricsGranularity } from '@/lib/metrics'
import { useTheme, type ChartStyle } from '@/components/theme-provider'
import type { EventMetricPoint } from '@/types'

interface MetricsChartProps {
  data: EventMetricPoint[]
  className?: string
  color?: string
  height?: number
  granularity?: MetricsGranularity
  seriesLabel?: string
}

interface MiniMetricsChartProps {
  data: EventMetricPoint[]
  className?: string
  color?: string
  height?: number
}

interface MetricsMultiSeriesChartProps {
  series: Array<{
    label: string
    data: EventMetricPoint[]
    color?: string
  }>
  className?: string
  height?: number
  granularity?: MetricsGranularity
  seriesLabel?: string
}

function formatTick(dateStr: string, granularity: MetricsGranularity) {
  const d = new Date(dateStr)

  switch (granularity) {
    case 'hour':
      return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit' })
    case 'day':
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    case 'week':
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    case 'month':
      return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  }
}

function formatTooltipLabel(dateStr: string, granularity: MetricsGranularity) {
  const d = new Date(dateStr)

  switch (granularity) {
    case 'hour':
      return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    case 'day':
      return d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    case 'week':
      return `Week of ${d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })}`
    case 'month':
      return d.toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
      })
  }
}

function formatCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

// Width of the confidence band drawn around expected_count: ±2σ ≈ 95%
// coverage on a normal-ish baseline. Matches what the anomaly detector
// effectively flags (default sigma_threshold ~2.5–3) without making the
// band so wide it always swallows the actual series.
const CONFIDENCE_BAND_K = 2

interface ChartDataPoint extends EventMetricPoint {
  band?: [number, number]
}

function buildChartData(data: EventMetricPoint[]): ChartDataPoint[] {
  return data.map(point => {
    if (point.expected_count == null || point.stddev == null) {
      return point
    }
    const offset = CONFIDENCE_BAND_K * point.stddev
    return {
      ...point,
      band: [point.expected_count - offset, point.expected_count + offset],
    }
  })
}

function CustomTooltip({
  active,
  payload,
  label,
  granularity,
  seriesLabel,
}: {
  active?: boolean
  payload?: Array<{ value: number; dataKey?: string; payload: ChartDataPoint }>
  label?: string | number
  granularity: MetricsGranularity
  seriesLabel: string
}) {
  if (!active || !payload?.length) return null
  const point = payload[0].payload
  const expectedCount = point.expected_count
  const deviation = expectedCount === null ? null : point.count - expectedCount

  return (
    <div className="rounded-lg border bg-background px-3 py-2 shadow-md">
      <p className="text-xs text-muted-foreground">{formatTooltipLabel(String(label ?? ''), granularity)}</p>
      <p className="text-sm font-semibold">{point.count.toLocaleString()} {seriesLabel}</p>
      {expectedCount !== null && (
        <p className="text-xs text-muted-foreground">
          Expected: {Math.round(expectedCount).toLocaleString()}
        </p>
      )}
      {point.band && (
        <p className="text-xs text-muted-foreground">
          ±{CONFIDENCE_BAND_K}σ band: {Math.round(point.band[0]).toLocaleString()}–{Math.round(point.band[1]).toLocaleString()}
        </p>
      )}
      {deviation !== null && (
        <p className={cn('text-xs', point.is_anomaly ? 'text-destructive' : 'text-muted-foreground')}>
          Deviation: {deviation > 0 ? '+' : ''}{Math.round(deviation).toLocaleString()}
        </p>
      )}
    </div>
  )
}

function MultiSeriesTooltip({
  active,
  payload,
  label,
  granularity,
  seriesLabel,
}: {
  active?: boolean
  payload?: Array<{ value: number; dataKey?: string; color?: string; name?: string }>
  label?: string | number
  granularity: MetricsGranularity
  seriesLabel: string
}) {
  if (!active || !payload?.length) return null
  const visiblePayload = payload.filter(item => typeof item.value === 'number')
  if (!visiblePayload.length) return null

  return (
    <div className="max-w-xs rounded-lg border bg-background px-3 py-2 shadow-md">
      <p className="text-xs text-muted-foreground">{formatTooltipLabel(String(label ?? ''), granularity)}</p>
      <div className="mt-1 space-y-1">
        {visiblePayload.map(item => (
          <div key={item.dataKey} className="flex items-center justify-between gap-4 text-xs">
            <span className="flex min-w-0 items-center gap-1">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
              <span className="truncate">{item.name}</span>
            </span>
            <span className="font-medium">{Number(item.value).toLocaleString()} {seriesLabel}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function MetricsChart({
  data,
  className,
  color,
  height = 300,
  granularity = 'hour',
  seriesLabel = 'events',
}: MetricsChartProps) {
  const { chartStyle } = useTheme()
  const chartColor = color || 'var(--chart-1)'
  const gradientId = useId().replace(/:/g, '')
  const chartData = useMemo(() => buildChartData(data), [data])

  if (!data.length) {
    return (
      <div className={cn('flex items-center justify-center text-muted-foreground text-sm', className)} style={{ height }}>
        No metrics data available
      </div>
    )
  }

  return (
    <div className={cn('w-full', className)} style={{ height }}>
      <div className="sr-only">
        {data.filter(point => point.is_anomaly).map(point => (
          <span key={point.bucket} data-testid="anomaly-dot">
            {point.bucket}
          </span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={chartColor} stopOpacity={0.3} />
              <stop offset="95%" stopColor={chartColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
          <XAxis
            dataKey="bucket"
            tickFormatter={value => formatTick(String(value), granularity)}
            className="text-xs fill-muted-foreground"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            tickFormatter={formatCount}
            className="text-xs fill-muted-foreground"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={48}
          />
          <Tooltip content={<CustomTooltip granularity={granularity} seriesLabel={seriesLabel} />} />
          {/* Confidence band — recharts renders a 2-tuple dataKey as a vertical range area. */}
          <Area
            type="monotone"
            dataKey="band"
            stroke="none"
            fill="var(--muted-foreground)"
            fillOpacity={0.12}
            isAnimationActive={false}
            connectNulls={false}
            activeDot={false}
            legendType="none"
          />
          <Line
            type="monotone"
            dataKey="expected_count"
            stroke="var(--muted-foreground)"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            dot={false}
            connectNulls={false}
          />
          {renderCountSeries({
            chartStyle,
            chartColor,
            gradientId,
            mini: false,
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

const MULTI_SERIES_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  '#0f766e',
  '#b45309',
  '#be123c',
]

export function MetricsMultiSeriesChart({
  series,
  className,
  height = 300,
  granularity = 'hour',
  seriesLabel = 'events',
}: MetricsMultiSeriesChartProps) {
  const chartSeries = useMemo(
    () => series
      .filter(item => item.data.length > 0)
      .map((item, index) => ({
        ...item,
        key: `series_${index}`,
        color: item.color ?? MULTI_SERIES_COLORS[index % MULTI_SERIES_COLORS.length],
      })),
    [series],
  )
  const chartData = useMemo(() => {
    const rows = new Map<string, Record<string, string | number | boolean>>()
    for (const item of chartSeries) {
      for (const point of item.data) {
        const row = rows.get(point.bucket) ?? { bucket: point.bucket }
        row[item.key] = point.count
        row[`${item.key}__anomaly`] = point.is_anomaly
        rows.set(point.bucket, row)
      }
    }
    return Array.from(rows.values()).sort((left, right) =>
      String(left.bucket).localeCompare(String(right.bucket)),
    )
  }, [chartSeries])

  if (!chartSeries.length || !chartData.length) {
    return (
      <div className={cn('flex items-center justify-center text-muted-foreground text-sm', className)} style={{ height }}>
        No breakdown metrics available
      </div>
    )
  }

  return (
    <div className={cn('w-full', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
          <XAxis
            dataKey="bucket"
            tickFormatter={value => formatTick(String(value), granularity)}
            className="text-xs fill-muted-foreground"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            tickFormatter={formatCount}
            className="text-xs fill-muted-foreground"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={48}
          />
          <Tooltip content={<MultiSeriesTooltip granularity={granularity} seriesLabel={seriesLabel} />} />
          {chartSeries.map(item => (
            <Line
              key={item.key}
              type="monotone"
              dataKey={item.key}
              name={item.label}
              stroke={item.color}
              strokeWidth={2}
              dot={(props: { cx?: number; cy?: number; payload?: Record<string, unknown> }) => {
                if (!props.payload?.[`${item.key}__anomaly`]) return <></>
                return (
                  <circle
                    cx={props.cx}
                    cy={props.cy}
                    r={4}
                    fill="var(--destructive)"
                    stroke="var(--background)"
                    strokeWidth={2}
                    data-testid="anomaly-dot"
                  />
                )
              }}
              activeDot={{ r: 4, strokeWidth: 0 }}
              connectNulls={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

function renderCountSeries({
  chartStyle,
  chartColor,
  gradientId,
  mini,
}: {
  chartStyle: ChartStyle
  chartColor: string
  gradientId: string
  mini: boolean
}) {
  const anomalyDot = (props: { cx?: number; cy?: number; payload?: EventMetricPoint }) => {
    if (!props.payload?.is_anomaly) return <></>
    const r = mini ? 3 : 4
    return (
      <circle
        cx={props.cx}
        cy={props.cy}
        r={r}
        fill="var(--destructive)"
        stroke="var(--background)"
        strokeWidth={mini ? 1.5 : 2}
        data-testid="anomaly-dot"
      />
    )
  }

  if (chartStyle === 'bar') {
    return (
      <Bar
        dataKey="count"
        fill={chartColor}
        radius={[2, 2, 0, 0]}
        shape={(props: AnomalyBarProps) => <AnomalyBar {...props} chartColor={chartColor} />}
      />
    )
  }

  if (chartStyle === 'line-only') {
    return (
      <Line
        type="monotone"
        dataKey="count"
        stroke={chartColor}
        strokeWidth={2}
        dot={anomalyDot}
        activeDot={mini ? false : { r: 4, strokeWidth: 0 }}
      />
    )
  }

  return (
    <Area
      type="monotone"
      dataKey="count"
      stroke={chartColor}
      fill={`url(#${gradientId})`}
      strokeWidth={2}
      dot={anomalyDot}
      activeDot={mini ? false : { r: 4, strokeWidth: 0 }}
    />
  )
}

type AnomalyBarProps = {
  x?: number
  y?: number
  width?: number
  height?: number
  payload?: EventMetricPoint
}

function AnomalyBar({
  x,
  y,
  width,
  height,
  payload,
  chartColor,
}: AnomalyBarProps & { chartColor: string }) {
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return <g />
  }
  const fill = payload?.is_anomaly ? 'var(--destructive)' : chartColor
  return <rect x={x} y={y} width={width} height={height} fill={fill} rx={2} ry={2} />
}

export function MiniMetricsChart({
  data,
  className,
  color,
  height = 72,
}: MiniMetricsChartProps) {
  const { chartStyle } = useTheme()
  const chartColor = color || 'var(--chart-1)'
  const gradientId = useId().replace(/:/g, '')

  if (!data.length) {
    return (
      <div
        className={cn('flex items-center justify-center text-[11px] text-muted-foreground', className)}
        style={{ height }}
      >
        No recent events
      </div>
    )
  }

  return (
    <div className={cn('w-full', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={chartColor} stopOpacity={0.25} />
              <stop offset="95%" stopColor={chartColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          {renderCountSeries({
            chartStyle,
            chartColor,
            gradientId,
            mini: true,
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
