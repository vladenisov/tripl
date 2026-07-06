import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Area,
  Bar,
  ComposedChart,
  CartesianGrid,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { cn } from '@/lib/utils'
import { axisWidthForValues, formatCount } from '@/components/ui/chart-format'
import type { MetricsGranularity } from '@/lib/metrics'
import { useTheme, type ChartStyle } from '@/components/theme-provider'
import type { ChartAnnotation, EventMetricPoint, ForecastPoint } from '@/types'

interface MetricsChartProps {
  data: EventMetricPoint[]
  forecast?: ForecastPoint[]
  annotations?: ChartAnnotation[]
  className?: string
  color?: string
  height?: number
  granularity?: MetricsGranularity
  seriesLabel?: string
  /**
   * Optional formatter for the numeric values on the Y axis and in the
   * tooltip (e.g. percent-unit catalog metrics render stored fractions ×100).
   * The formatted string carries its own unit, so the tooltip skips the
   * `seriesLabel` suffix. When omitted, the chart keeps its default
   * compact-count ticks and `value seriesLabel` tooltip lines.
   */
  valueFormatter?: (value: number) => string
}

interface MiniMetricsChartProps {
  data: EventMetricPoint[]
  className?: string
  color?: string
  height?: number
  label?: string
}

interface MetricsMultiSeriesChartProps {
  series: Array<{
    label: string
    data: EventMetricPoint[]
    color?: string
    isHighlighted?: boolean
  }>
  className?: string
  height?: number
  granularity?: MetricsGranularity
  seriesLabel?: string
  emptyLabel?: string
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

function collectChartYValues(data: ChartDataPoint[]): number[] {
  const values: number[] = []
  for (const point of data) {
    if (point.count != null) values.push(point.count)
    if (point.expected_count != null) values.push(point.expected_count)
    if (point.band) values.push(point.band[0], point.band[1])
    if (point.forecast_expected != null) values.push(point.forecast_expected)
    if (point.forecast_band) values.push(point.forecast_band[0], point.forecast_band[1])
  }
  return values
}

function collectMultiSeriesYValues(
  rows: Array<Record<string, string | number | boolean>>,
): number[] {
  const values: number[] = []
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (typeof value === 'number') values.push(value)
    }
  }
  return values
}

/**
 * Track whether the chart's container has a positive on-screen size. Recharts'
 * ResponsiveContainer logs "The width(-1) and height(-1) of chart should be
 * greater than 0" when it mounts inside a zero-size parent (a collapsed tab, or
 * a collapsible mid-open animation). Gate the ResponsiveContainer on a real
 * measured size so recharts never receives -1. The wrapper keeps its fixed
 * height and `w-full` regardless, so nothing shifts while we wait for a size.
 */
function useChartContainerReady() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const { width, height } = element.getBoundingClientRect()
      setReady(width > 0 && height > 0)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return { ref, ready }
}

// Width of the confidence band drawn around expected_count: ±2σ ≈ 95%
// coverage on a normal-ish baseline. Matches what the anomaly detector
// effectively flags (default sigma_threshold ~2.5–3) without making the
// band so wide it always swallows the actual series.
const CONFIDENCE_BAND_K = 2

interface ChartDataPoint {
  bucket: string
  count: number | null
  expected_count: number | null
  stddev: number | null
  is_anomaly?: boolean
  anomaly_direction?: 'spike' | 'drop' | null
  z_score?: number | null
  band?: [number, number]
  forecast_expected?: number
  forecast_band?: [number, number]
  is_forecast?: boolean
}

function buildChartData(
  data: EventMetricPoint[],
  forecast: ForecastPoint[] = [],
): ChartDataPoint[] {
  const points: ChartDataPoint[] = data.map(point => {
    if (point.expected_count == null || point.stddev == null) {
      return { ...point }
    }
    const offset = CONFIDENCE_BAND_K * point.stddev
    return {
      ...point,
      band: [point.expected_count - offset, point.expected_count + offset],
    }
  })

  if (forecast.length > 0 && points.length > 0) {
    // Anchor the dashed forecast line to the last actual count so the
    // preview visibly extends *from* the chart instead of floating.
    const anchor = points[points.length - 1]
    anchor.forecast_expected = anchor.count ?? undefined
    if (anchor.stddev != null && anchor.count != null) {
      const anchorOffset = CONFIDENCE_BAND_K * anchor.stddev
      anchor.forecast_band = [anchor.count - anchorOffset, anchor.count + anchorOffset]
    }
    for (const point of forecast) {
      const offset = CONFIDENCE_BAND_K * point.stddev
      points.push({
        bucket: point.bucket,
        count: null,
        expected_count: null,
        stddev: null,
        forecast_expected: point.expected_count,
        forecast_band: [point.expected_count - offset, point.expected_count + offset],
        is_forecast: true,
      })
    }
  }

  return points
}

// Exported for unit tests only — recharts never paints its tooltip in jsdom.
export function CustomTooltip({
  active,
  payload,
  label,
  granularity,
  seriesLabel,
  valueFormatter,
}: {
  active?: boolean
  payload?: Array<{ value: number; dataKey?: string; payload: ChartDataPoint }>
  label?: string | number
  granularity: MetricsGranularity
  seriesLabel: string
  valueFormatter?: (value: number) => string
}) {
  if (!active || !payload?.length) return null
  const point = payload[0].payload
  // A caller-provided formatter carries its own unit (e.g. '8%'), so the
  // secondary lines route through it instead of the default whole-number
  // rounding (which would collapse fractional metric values to 0).
  const formatSecondary = (value: number) =>
    valueFormatter ? valueFormatter(value) : Math.round(value).toLocaleString()

  if (point.is_forecast && point.forecast_expected != null) {
    return (
      <div className="rounded-lg border border-dashed bg-background px-3 py-2 shadow-md">
        <p className="text-xs text-muted-foreground">{formatTooltipLabel(String(label ?? ''), granularity)}</p>
        <p className="text-sm font-semibold">
          ~{valueFormatter
            ? valueFormatter(point.forecast_expected)
            : `${Math.round(point.forecast_expected).toLocaleString()} ${seriesLabel}`}
        </p>
        <p className="text-xs text-muted-foreground">Forecast (next bucket)</p>
        {point.forecast_band && (
          <p className="text-xs text-muted-foreground">
            ±{CONFIDENCE_BAND_K}σ band: {formatSecondary(point.forecast_band[0])}–{formatSecondary(point.forecast_band[1])}
          </p>
        )}
      </div>
    )
  }

  const expectedCount = point.expected_count
  const count = point.count ?? 0
  const deviation = expectedCount === null ? null : count - expectedCount

  return (
    <div className="rounded-lg border bg-background px-3 py-2 shadow-md">
      <p className="text-xs text-muted-foreground">{formatTooltipLabel(String(label ?? ''), granularity)}</p>
      <p className="text-sm font-semibold">
        {valueFormatter ? valueFormatter(count) : `${count.toLocaleString()} ${seriesLabel}`}
      </p>
      {expectedCount !== null && (
        <p className="text-xs text-muted-foreground">
          Expected: {formatSecondary(expectedCount)}
        </p>
      )}
      {point.band && (
        <p className="text-xs text-muted-foreground">
          ±{CONFIDENCE_BAND_K}σ band: {formatSecondary(point.band[0])}–{formatSecondary(point.band[1])}
        </p>
      )}
      {deviation !== null && (
        <p className={cn('text-xs', point.is_anomaly ? 'text-destructive' : 'text-muted-foreground')}>
          Deviation: {deviation > 0 ? '+' : ''}{formatSecondary(deviation)}
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

function snapAnnotationsToBuckets(
  annotations: ChartAnnotation[] | undefined,
  data: ChartDataPoint[],
): Array<{ id: string; bucket: string; label: string; color: string }> {
  if (!annotations?.length || !data.length) return []
  // Categorical x-axis only renders ReferenceLine for x values that exist
  // on rendered points, so snap each annotation to the closest bucket in
  // the visible data. Annotations outside the window simply drop.
  const bucketTimes = data.map(point => new Date(point.bucket).getTime())
  return annotations
    .map(annotation => {
      const annotationTime = new Date(annotation.bucket).getTime()
      if (Number.isNaN(annotationTime)) return null
      if (annotationTime < bucketTimes[0] || annotationTime > bucketTimes[bucketTimes.length - 1]) {
        return null
      }
      let closestIndex = 0
      let closestDelta = Math.abs(annotationTime - bucketTimes[0])
      for (let i = 1; i < bucketTimes.length; i++) {
        const delta = Math.abs(annotationTime - bucketTimes[i])
        if (delta < closestDelta) {
          closestDelta = delta
          closestIndex = i
        }
      }
      return {
        id: annotation.id,
        bucket: data[closestIndex].bucket,
        label: annotation.label,
        color: annotation.color || 'var(--destructive)',
      }
    })
    .filter((value): value is { id: string; bucket: string; label: string; color: string } => value !== null)
}

export function MetricsChart({
  data,
  forecast,
  annotations,
  className,
  color,
  height = 300,
  granularity = 'hour',
  seriesLabel = 'events',
  valueFormatter,
}: MetricsChartProps) {
  const { chartStyle } = useTheme()
  const chartColor = color || 'var(--chart-1)'
  const gradientId = useId().replace(/:/g, '')
  const descId = useId()
  const chartData = useMemo(() => buildChartData(data, forecast), [data, forecast])
  const snappedAnnotations = useMemo(
    () => snapAnnotationsToBuckets(annotations, chartData),
    [annotations, chartData],
  )
  const { ref: containerRef, ready: containerReady } = useChartContainerReady()
  const yAxisWidth = useMemo(
    () => axisWidthForValues(collectChartYValues(chartData), valueFormatter ?? formatCount),
    [chartData, valueFormatter],
  )

  if (!data.length) {
    return (
      <div className={cn('flex items-center justify-center text-muted-foreground text-sm', className)} style={{ height }}>
        No metrics data available
      </div>
    )
  }

  const anomalyCount = data.filter(point => point.is_anomaly).length

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={`${seriesLabel} over time`}
      aria-describedby={descId}
      className={cn('w-full', className)}
      style={{ height }}
    >
      <div id={descId} className="sr-only">
        {data.length} data points.{anomalyCount > 0 ? ` ${anomalyCount} anomalies detected.` : ''}
        {data.filter(point => point.is_anomaly).map(point => (
          <span key={point.bucket} data-testid="anomaly-dot">
            {point.bucket}
          </span>
        ))}
        {(forecast ?? []).map(point => (
          <span key={point.bucket} data-testid="forecast-point">
            {point.bucket}: {Math.round(point.expected_count)}
          </span>
        ))}
        {snappedAnnotations.map(annotation => (
          <span key={annotation.id} data-testid="chart-annotation">
            {annotation.bucket}: {annotation.label}
          </span>
        ))}
      </div>
      {containerReady ? (
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
            tickFormatter={valueFormatter ?? formatCount}
            className="text-xs fill-muted-foreground"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={yAxisWidth}
          />
          <Tooltip
            content={
              <CustomTooltip
                granularity={granularity}
                seriesLabel={seriesLabel}
                valueFormatter={valueFormatter}
              />
            }
          />
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
          {/* Forecast preview: same dashed style as `expected_count` but in the
              series color so it visibly extends from the chart edge. */}
          <Area
            type="monotone"
            dataKey="forecast_band"
            stroke="none"
            fill={chartColor}
            fillOpacity={0.08}
            isAnimationActive={false}
            connectNulls
            activeDot={false}
            legendType="none"
          />
          <Line
            type="monotone"
            dataKey="forecast_expected"
            stroke={chartColor}
            strokeDasharray="6 4"
            strokeWidth={1.75}
            strokeOpacity={0.7}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
          {renderCountSeries({
            chartStyle,
            chartColor,
            gradientId,
            mini: false,
          })}
          {snappedAnnotations.map(annotation => (
            <ReferenceLine
              key={annotation.id}
              x={annotation.bucket}
              stroke={annotation.color}
              strokeDasharray="2 3"
              strokeWidth={1.5}
              label={{
                value: annotation.label,
                position: 'top',
                fill: annotation.color,
                fontSize: 10,
              }}
              ifOverflow="extendDomain"
            />
          ))}
        </ComposedChart>
        </ResponsiveContainer>
      ) : null}
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
  emptyLabel = 'No breakdown metrics available',
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
  const { ref: containerRef, ready: containerReady } = useChartContainerReady()
  const yAxisWidth = useMemo(
    () => axisWidthForValues(collectMultiSeriesYValues(chartData), formatCount),
    [chartData],
  )

  if (!chartSeries.length || !chartData.length) {
    return (
      <div className={cn('flex items-center justify-center text-muted-foreground text-sm', className)} style={{ height }}>
        {emptyLabel}
      </div>
    )
  }

  const multiSeriesLabel = seriesLabel

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={`${multiSeriesLabel} breakdown over time`}
      className={cn('w-full', className)}
      style={{ height }}
    >
      <div className="sr-only">
        <p>Chart with {chartSeries.length} series: {chartSeries.map(s => s.label).join(', ')}.</p>
        {chartSeries.map(item => {
          const anomalies = item.data.filter(point => point.is_anomaly)
          return anomalies.length > 0 ? (
            <p key={item.key}>{item.label}: {anomalies.length} anomalies detected.</p>
          ) : null
        })}
      </div>
      {containerReady ? (
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
            width={yAxisWidth}
          />
          <Tooltip content={<MultiSeriesTooltip granularity={granularity} seriesLabel={seriesLabel} />} />
          {chartSeries.map(item => (
            <Line
              key={item.key}
              type="monotone"
              dataKey={item.key}
              name={item.label}
              stroke={item.color}
              strokeWidth={item.isHighlighted ? 3 : 2}
              strokeOpacity={item.isHighlighted ? 1 : 0.82}
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
              activeDot={{ r: item.isHighlighted ? 5 : 4, strokeWidth: 0 }}
              connectNulls={false}
            />
          ))}
        </ComposedChart>
        </ResponsiveContainer>
      ) : null}
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
  label,
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

  const anomalyCount = data.filter(point => point.is_anomaly).length
  const chartLabel = label ?? 'Metric trend chart'

  return (
    <div
      role="img"
      aria-label={chartLabel}
      className={cn('w-full', className)}
      style={{ height }}
    >
      <span className="sr-only">
        {chartLabel}: {data.length} data points{anomalyCount > 0 ? `, ${anomalyCount} anomalies` : ''}.
      </span>
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
