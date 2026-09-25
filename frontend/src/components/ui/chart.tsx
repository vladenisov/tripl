import { Fragment, useCallback, useId, useMemo, useRef, useState } from 'react'
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
import {
  axisWidthForValues,
  CHART_SURFACE_TAB_INDEX,
  dayBoundaryTicks,
  EVENTS_NOUN,
  formatAnomalyCount,
  formatCount,
  formatDayTick,
  formatSeriesValue,
  formatTick,
  formatTooltipLabel,
  SERIES_COLORS,
  seriesNounPlural,
  summarizeBuckets,
  summarizeForecastRange,
  type SeriesNoun,
} from '@/components/ui/chart-format'
import { formatNumber } from '@/lib/format'
import type { MetricsGranularity } from '@/lib/metrics'
import { useTheme, type ChartStyle } from '@/components/theme-provider'
import type { ChartAnnotation, EventMetricPoint, ForecastPoint } from '@/types'
import { annotationDisplayColor, truncateAnnotationLabel } from '@/lib/chartAnnotations'
import { signalDirectionColor } from '@/lib/statusLexicon'
import { windowPaddingBuckets } from '@/components/ui/chart-window'

/**
 * The default colour of a single-series chart (DS-27): the first categorical
 * slot, a fixed hue that does not follow the user's accent. "Volume over time"
 * used to be drawn in the accent on one page, teal on another and violet on a
 * third. Anomalies are marked with danger dots and bands, never by recolouring
 * the line, so pass `color` only for a series that means something else.
 */
export const SINGLE_SERIES_COLOR = SERIES_COLORS[0]

interface MetricsChartProps {
  data: EventMetricPoint[]
  forecast?: ForecastPoint[]
  annotations?: ChartAnnotation[]
  className?: string
  color?: string
  height?: number
  granularity?: MetricsGranularity
  /** What the values count; the pair form pluralizes ("1 event"). */
  seriesLabel?: SeriesNoun
  /**
   * Optional formatter for the numeric values on the Y axis and in the
   * tooltip (e.g. percent-unit catalog metrics render stored fractions ×100).
   * The formatted string carries its own unit, so the tooltip skips the
   * `seriesLabel` suffix. When omitted, the chart keeps its default
   * compact-count ticks and `value seriesLabel` tooltip lines.
   */
  valueFormatter?: (value: number) => string
  /**
   * Formats the tooltip values when they need more than the axis does: a tick
   * leaves a trailing unit off ('0.0045'), the tooltip spells the value out
   * ('0.0045 s', '$1,234'). Falls back to `valueFormatter`. Like it, the
   * string carries its own unit, so the `seriesLabel` suffix is skipped.
   */
  tooltipFormatter?: (value: number) => string
  /**
   * The sigma threshold the detector actually scored this scope with, served on
   * the metrics response as `sigma_threshold`: the PROJECT setting, narrowed by
   * any false-positive scope override (`metrics_service._apply_scope_sigma_override`).
   * The confidence band is drawn as `expected ± sigmaThreshold * stddev` using
   * the STORED effective stddev, so a flagged point sits outside the band.
   * Falls back to `DEFAULT_SIGMA_THRESHOLD` when the payload carries none.
   */
  sigmaThreshold?: number
  /**
   * Clamp the confidence and forecast bands at zero (MON-21). A count cannot be
   * negative, but `expected - k·σ` can, and the band then dragged the axis
   * below zero on every quiet scope. Defaults to on for count series — no
   * `valueFormatter` — and off for catalog metrics, which may be signed.
   */
  nonNegative?: boolean
  /**
   * The window the reader asked for. The x-axis is padded with empty buckets
   * out to it, so a series that starts late in a 30-day range is drawn at its
   * real position rather than stretched edge-to-edge (MON-22).
   */
  from?: string
  to?: string
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
    /**
     * SVG dash pattern. The palette has eight hues, so a ninth series reuses
     * the first one's colour and needs a second cue to stay distinguishable
     * (MON-29).
     */
    dash?: string
    isHighlighted?: boolean
  }>
  className?: string
  height?: number
  granularity?: MetricsGranularity
  /** See MetricsChartProps.seriesLabel. */
  seriesLabel?: SeriesNoun
  emptyLabel?: string
  /**
   * Optional formatter for Y-axis ticks and tooltip values, mirroring
   * `MetricsChartProps.valueFormatter` (percent-unit catalog metrics render
   * stored fractions ×100). The formatted string carries its own unit, so the
   * tooltip skips the `seriesLabel` suffix. When omitted, the chart keeps its
   * default compact-count ticks and `value seriesLabel` tooltip lines.
   */
  valueFormatter?: (value: number) => string
  /** See MetricsChartProps.tooltipFormatter. */
  tooltipFormatter?: (value: number) => string
  /** See MetricsChartProps.from / .to (MON-22). */
  from?: string
  to?: string
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
 * X-axis tick props for a bucket axis. A sub-day series spanning two days or
 * more gets one tick per local day, labelled with the date alone; anything
 * shorter keeps recharts' spacing and the full bucket label (LIVE-27).
 * `preserveStartEnd` keeps the first day when the axis is too narrow for every
 * tick — the default `preserveEnd` dropped it at 768px.
 */
function useTimeAxisTicks(
  rows: Array<{ bucket: string }>,
  granularity: MetricsGranularity,
) {
  const ticks = useMemo(
    () => dayBoundaryTicks(rows.map(row => row.bucket), granularity),
    [rows, granularity],
  )
  return ticks
    ? {
        ticks,
        interval: 'preserveStartEnd' as const,
        tickFormatter: (value: unknown) => formatDayTick(String(value)),
      }
    : { tickFormatter: (value: unknown) => formatTick(String(value), granularity) }
}

/**
 * Track whether the chart's container has a positive on-screen size. Recharts'
 * ResponsiveContainer logs "The width(-1) and height(-1) of chart should be
 * greater than 0" when it mounts inside a zero-size parent (a collapsed tab, or
 * a collapsible mid-open animation). Gate the ResponsiveContainer on a real
 * measured size so recharts never receives -1. The wrapper keeps its fixed
 * height and `w-full` regardless, so nothing shifts while we wait for a size.
 *
 * A callback ref, not a mount-time effect: MiniMetricsChart attaches the ref
 * only once it has data, so an effect that ran once on mount found no element
 * and left a chart that later received points blank; and after data -> [] ->
 * data it kept observing the detached old node. The callback re-runs on every
 * attach and detach.
 */
function useChartContainerReady() {
  const [ready, setReady] = useState(false)
  const observerRef = useRef<ResizeObserver | null>(null)

  const ref = useCallback((element: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!element) {
      setReady(false)
      return
    }
    const measure = () => {
      const { width, height } = element.getBoundingClientRect()
      setReady(width > 0 && height > 0)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    observerRef.current = observer
  }, [])

  return { ref, ready }
}

// Fallback confidence-band multiplier when the series response does not carry a
// `sigma_threshold` (e.g. older payloads). The band is drawn as
// `expected ± sigma_threshold * effective_stddev` using the STORED effective
// stddev the backend serves in `stddev`, so "outside the band" == "flagged".
// 4.0 is the detector's own default, `ProjectAnomalySettings.sigma_threshold`
// (models/project_anomaly_settings.py). It is a PROJECT setting, not a
// scan-config one — the scan-config copy has no reader left in the backend.
// This was 3.0 with a comment claiming the scan-config default, wrong on both
// counts, so a payload without a threshold drew a band a quarter too narrow and
// made unflagged buckets look flagged (tripl-0zpq.299).
//
// Every scope now serves a real per-scope sigma (event, event-type and
// project-total since tripl-0zpq.299; events-total since tripl-e443; the catalog
// metric since tripl-4cgl, threaded through `adaptMetricSeries`), so this
// constant only covers a payload that predates the field.
const DEFAULT_SIGMA_THRESHOLD = 4

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

// Exported for unit tests only — recharts never paints in jsdom, so the band
// geometry is verified on the pure builder.
// eslint-disable-next-line react-refresh/only-export-components
export function buildChartData(
  data: EventMetricPoint[],
  forecast: ForecastPoint[] = [],
  sigmaThreshold: number = DEFAULT_SIGMA_THRESHOLD,
  nonNegative = false,
): ChartDataPoint[] {
  // Robust to a missing/invalid served threshold: fall back to the default.
  const k = Number.isFinite(sigmaThreshold) && sigmaThreshold > 0
    ? sigmaThreshold
    : DEFAULT_SIGMA_THRESHOLD
  // A count's band stops at zero (MON-21); a signed metric's does not.
  const floor = (value: number) => (nonNegative ? Math.max(0, value) : value)
  const points: ChartDataPoint[] = data.map(point => {
    if (point.expected_count == null || point.stddev == null) {
      return { ...point }
    }
    const offset = k * point.stddev
    return {
      ...point,
      band: [floor(point.expected_count - offset), point.expected_count + offset],
    }
  })

  // Anchor the dashed forecast line to the last actual count so the
  // preview visibly extends *from* the chart instead of floating.
  const anchor = points[points.length - 1]
  if (forecast.length > 0 && anchor) {
    anchor.forecast_expected = anchor.count ?? undefined
    if (anchor.stddev != null && anchor.count != null) {
      const anchorOffset = k * anchor.stddev
      anchor.forecast_band = [floor(anchor.count - anchorOffset), anchor.count + anchorOffset]
    }
    for (const point of forecast) {
      const offset = k * point.stddev
      points.push({
        bucket: point.bucket,
        count: null,
        expected_count: null,
        stddev: null,
        forecast_expected: nonNegative ? Math.max(0, point.expected_count) : point.expected_count,
        forecast_band: [floor(point.expected_count - offset), point.expected_count + offset],
        is_forecast: true,
      })
    }
  }

  return points
}

/** Empty padding rows, typed for whichever row shape the chart uses (MON-22). */
function padRows<Row extends { bucket: string }>(
  rows: Row[],
  window: { from?: string; to?: string },
  granularity: MetricsGranularity,
  empty: (bucket: string) => Row,
): Row[] {
  const first = rows[0]
  const last = rows[rows.length - 1]
  if (!first || !last || (!window.from && !window.to)) return rows
  const { before, after } = windowPaddingBuckets(first.bucket, last.bucket, window, granularity)
  if (!before.length && !after.length) return rows
  return [...before.map(empty), ...rows, ...after.map(empty)]
}

// Exported for unit tests only — recharts never paints in jsdom.
// eslint-disable-next-line react-refresh/only-export-components
export function padChartData(
  rows: ChartDataPoint[],
  window: { from?: string; to?: string },
  granularity: MetricsGranularity,
): ChartDataPoint[] {
  return padRows(rows, window, granularity, bucket => ({
    bucket,
    count: null,
    expected_count: null,
    stddev: null,
  }))
}

/**
 * The anomaly line of a tooltip: which way it moved and how far (MON-17). The
 * dot was the only mark, in one red for spikes and drops alike, and hovering it
 * said nothing the plain line did not.
 */
function AnomalyTooltipLine({
  direction,
  zScore,
  prefix = 'Anomaly',
}: {
  direction?: 'spike' | 'drop' | null
  zScore?: number | null
  prefix?: string
}) {
  const z = zScore != null && Number.isFinite(zScore) ? ` (z=${zScore.toFixed(1)})` : ''
  return (
    <p
      className="text-body-sm font-medium"
      style={{ color: direction ? signalDirectionColor(direction) : 'var(--danger)' }}
    >
      {prefix}: {direction ?? 'flagged'}{z}
    </p>
  )
}

// Exported for unit tests only — recharts never paints its tooltip in jsdom.
export function CustomTooltip({
  active,
  payload,
  label,
  granularity,
  seriesLabel,
  valueFormatter: axisFormatter,
  tooltipFormatter,
  sigmaThreshold = DEFAULT_SIGMA_THRESHOLD,
}: {
  active?: boolean
  payload?: Array<{ value: number; dataKey?: string; payload: ChartDataPoint }>
  label?: string | number
  granularity: MetricsGranularity
  seriesLabel: SeriesNoun
  valueFormatter?: (value: number) => string
  tooltipFormatter?: (value: number) => string
  sigmaThreshold?: number
}) {
  const point = payload?.[0]?.payload
  if (!active || !point) return null
  const valueFormatter = tooltipFormatter ?? axisFormatter
  const sigmaLabel = Number.isFinite(sigmaThreshold) && sigmaThreshold > 0
    ? sigmaThreshold
    : DEFAULT_SIGMA_THRESHOLD
  // A caller-provided formatter carries its own unit (e.g. '8%'), so the
  // secondary lines route through it instead of the default whole-number
  // rounding (which would collapse fractional metric values to 0).
  const formatSecondary = (value: number) =>
    valueFormatter ? valueFormatter(value) : formatNumber(Math.round(value))

  if (point.is_forecast && point.forecast_expected != null) {
    return (
      <div className="rounded-card border border-dashed bg-popover text-popover-foreground px-3 py-2 shadow-md">
        <p className="text-body-sm text-muted-foreground">{formatTooltipLabel(String(label ?? ''), granularity)}</p>
        <p className="text-body font-semibold">
          ~{valueFormatter
            ? valueFormatter(point.forecast_expected)
            : formatSeriesValue(Math.round(point.forecast_expected), seriesLabel)}
        </p>
        <p className="text-body-sm text-muted-foreground">Forecast (next bucket)</p>
        {point.forecast_band && (
          <p className="text-body-sm text-muted-foreground">
            ±{sigmaLabel}σ band: {formatSecondary(point.forecast_band[0])}–{formatSecondary(point.forecast_band[1])}
          </p>
        )}
      </div>
    )
  }

  // A padding bucket out at the window's edge (MON-22): no value, not zero.
  if (point.count == null && point.expected_count == null) {
    return (
      <div className="rounded-card border bg-popover text-popover-foreground px-3 py-2 shadow-md">
        <p className="text-body-sm text-muted-foreground">{formatTooltipLabel(String(label ?? ''), granularity)}</p>
        <p className="text-body-sm text-muted-foreground">No data for this bucket</p>
      </div>
    )
  }

  const expectedCount = point.expected_count
  const count = point.count ?? 0
  const deviation = expectedCount === null ? null : count - expectedCount

  return (
    <div className="rounded-card border bg-popover text-popover-foreground px-3 py-2 shadow-md">
      <p className="text-body-sm text-muted-foreground">{formatTooltipLabel(String(label ?? ''), granularity)}</p>
      <p className="text-body font-semibold">
        {valueFormatter ? valueFormatter(count) : formatSeriesValue(count, seriesLabel)}
      </p>
      {expectedCount !== null && (
        <p className="text-body-sm text-muted-foreground">
          Expected: {formatSecondary(expectedCount)}
        </p>
      )}
      {point.band && (
        <p className="text-body-sm text-muted-foreground">
          ±{sigmaLabel}σ band: {formatSecondary(point.band[0])}–{formatSecondary(point.band[1])}
        </p>
      )}
      {deviation !== null && (
        <p className={cn('text-body-sm', point.is_anomaly ? 'text-destructive' : 'text-muted-foreground')}>
          Deviation: {deviation > 0 ? '+' : ''}{formatSecondary(deviation)}
        </p>
      )}
      {point.is_anomaly && (
        <AnomalyTooltipLine direction={point.anomaly_direction} zScore={point.z_score} />
      )}
    </div>
  )
}

// Exported for unit tests only — recharts never paints its tooltip in jsdom
// (mirrors CustomTooltip above).
export function MultiSeriesTooltip({
  active,
  payload,
  label,
  granularity,
  seriesLabel,
  valueFormatter: axisFormatter,
  tooltipFormatter,
}: {
  active?: boolean
  payload?: Array<{
    value: number
    dataKey?: string
    color?: string
    name?: string
    payload?: Record<string, unknown>
  }>
  label?: string | number
  granularity: MetricsGranularity
  seriesLabel: SeriesNoun
  valueFormatter?: (value: number) => string
  tooltipFormatter?: (value: number) => string
}) {
  const valueFormatter = tooltipFormatter ?? axisFormatter
  if (!active || !payload?.length) return null
  const visiblePayload = payload.filter(item => typeof item.value === 'number')
  if (!visiblePayload.length) return null

  return (
    <div className="max-w-xs rounded-card border bg-popover text-popover-foreground px-3 py-2 shadow-md">
      <p className="text-body-sm text-muted-foreground">{formatTooltipLabel(String(label ?? ''), granularity)}</p>
      <div className="mt-1 space-y-1">
        {visiblePayload.map(item => (
          <div key={item.dataKey} className="flex items-center justify-between gap-4 text-body-sm">
            <span className="flex min-w-0 items-center gap-1">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
              <span className="truncate">{item.name}</span>
            </span>
            <span className="font-medium">
              {valueFormatter
                ? valueFormatter(Number(item.value))
                : formatSeriesValue(Number(item.value), seriesLabel)}
            </span>
          </div>
        ))}
      </div>
      {visiblePayload.map(item => {
        const row = item.payload
        if (!item.dataKey || !row?.[`${item.dataKey}__anomaly`]) return null
        const direction = row[`${item.dataKey}__direction`]
        const zScore = row[`${item.dataKey}__z`]
        return (
          <AnomalyTooltipLine
            key={`${item.dataKey}-anomaly`}
            prefix={`${item.name ?? 'Series'} anomaly`}
            direction={direction === 'spike' || direction === 'drop' ? direction : null}
            zScore={typeof zScore === 'number' ? zScore : null}
          />
        )
      })}
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
  const buckets = data.map(point => ({
    bucket: point.bucket,
    time: new Date(point.bucket).getTime(),
  }))
  const first = buckets[0]
  const last = buckets[buckets.length - 1]
  if (!first || !last) return []
  return annotations
    .map(annotation => {
      const annotationTime = new Date(annotation.bucket).getTime()
      if (Number.isNaN(annotationTime)) return null
      if (annotationTime < first.time || annotationTime > last.time) {
        return null
      }
      let closest = first
      let closestDelta = Math.abs(annotationTime - first.time)
      for (const candidate of buckets) {
        const delta = Math.abs(annotationTime - candidate.time)
        if (delta < closestDelta) {
          closestDelta = delta
          closest = candidate
        }
      }
      return {
        id: annotation.id,
        bucket: closest.bucket,
        label: annotation.label,
        color: annotationDisplayColor(annotation.color),
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
  seriesLabel = EVENTS_NOUN,
  valueFormatter,
  tooltipFormatter,
  sigmaThreshold = DEFAULT_SIGMA_THRESHOLD,
  nonNegative,
  from,
  to,
}: MetricsChartProps) {
  const { chartStyle } = useTheme()
  const chartColor = color || SINGLE_SERIES_COLOR
  const gradientId = useId().replace(/:/g, '')
  const descId = useId()
  const clampAtZero = nonNegative ?? valueFormatter === undefined
  const chartData = useMemo(
    () =>
      padChartData(
        buildChartData(data, forecast, sigmaThreshold, clampAtZero),
        { from, to: forecast?.length ? undefined : to },
        granularity,
      ),
    [data, forecast, sigmaThreshold, clampAtZero, from, to, granularity],
  )
  const snappedAnnotations = useMemo(
    () => snapAnnotationsToBuckets(annotations, chartData),
    [annotations, chartData],
  )
  const { ref: containerRef, ready: containerReady } = useChartContainerReady()
  const yAxisWidth = useMemo(
    () => axisWidthForValues(collectChartYValues(chartData), valueFormatter ?? formatCount),
    [chartData, valueFormatter],
  )
  const xAxisTicks = useTimeAxisTicks(chartData, granularity)
  const bucketIndex = useMemo(
    () => new Map(chartData.map((row, index) => [row.bucket, index])),
    [chartData],
  )

  if (!data.length) {
    return (
      <div className={cn('flex items-center justify-center text-muted-foreground text-body', className)} style={{ height }}>
        No metrics data available
      </div>
    )
  }

  const anomalyBuckets = data.filter(point => point.is_anomaly).map(point => point.bucket)
  const anomalyCount = anomalyBuckets.length
  const forecastBuckets = (forecast ?? []).map(point => point.bucket)

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={`${seriesNounPlural(seriesLabel)} over time`}
      aria-describedby={descId}
      className={cn('w-full', className)}
      style={{ height }}
    >
      <div id={descId} className="sr-only">
        {data.length} data points.
        {/* The separating spaces sit OUTSIDE the spans: an accessible name or
            description is built from each element's trimmed text, so a space
            inside a span was dropped and the sentences ran together
            ("points.1 anomaly"). */}
        {anomalyCount > 0 && (
          <>
            {' '}
            <span data-testid="anomaly-dot">
              {formatAnomalyCount(anomalyCount)}: {summarizeBuckets(anomalyBuckets, granularity)}.
            </span>
          </>
        )}
        {forecastBuckets.length > 0 && (
          <>
            {' '}
            <span data-testid="forecast-point">
              {summarizeForecastRange(forecastBuckets, granularity)}.
            </span>
          </>
        )}
        {/* Humanized like every other bucket in this summary, and separated:
            the raw ISO instants used to run together
            ("2026-09-24T10:00:00Z: Deploy2026-…", DS-25). */}
        {snappedAnnotations.length > 0 && (
          <>
            {' '}
            {snappedAnnotations.map((annotation, index) => (
              <Fragment key={annotation.id}>
                {index > 0 && '; '}
                <span data-testid="chart-annotation">
                  {formatTooltipLabel(annotation.bucket, granularity)}: {annotation.label}
                </span>
              </Fragment>
            ))}
            .
          </>
        )}
      </div>
      {containerReady ? (
        <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={chartData}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          tabIndex={CHART_SURFACE_TAB_INDEX}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={chartColor} stopOpacity={0.3} />
              <stop offset="95%" stopColor={chartColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
          <XAxis
            dataKey="bucket"
            {...xAxisTicks}
            className="text-body-sm fill-muted-foreground"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            tickFormatter={valueFormatter ?? formatCount}
            className="text-body-sm fill-muted-foreground"
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
                tooltipFormatter={tooltipFormatter}
                sigmaThreshold={sigmaThreshold}
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
              // Inside the plot, on the side with room: `top` drew the label
              // above the plot area, where the right edge clipped a label on
              // the newest bucket ("injected dem…", LIVE-22). A line in the
              // right half puts its label to its left, and vice versa.
              label={{
                value: truncateAnnotationLabel(annotation.label),
                position:
                  (bucketIndex.get(annotation.bucket) ?? 0) > (chartData.length - 1) / 2
                    ? 'insideTopRight'
                    : 'insideTopLeft',
                fill: annotation.color,
                fontSize: 'var(--text-micro)',
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

export function MetricsMultiSeriesChart({
  series,
  className,
  height = 300,
  granularity = 'hour',
  seriesLabel = EVENTS_NOUN,
  emptyLabel = 'No breakdown metrics available',
  valueFormatter,
  tooltipFormatter,
  from,
  to,
}: MetricsMultiSeriesChartProps) {
  const chartSeries = useMemo(
    () => series
      .filter(item => item.data.length > 0)
      .map((item, index) => ({
        ...item,
        key: `series_${index}`,
        color: item.color ?? SERIES_COLORS[index % SERIES_COLORS.length],
        hasAnomaly: item.data.some(point => point.is_anomaly),
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
        // Read back by the tooltip's anomaly line (MON-17).
        if (point.anomaly_direction) row[`${item.key}__direction`] = point.anomaly_direction
        if (point.z_score != null) row[`${item.key}__z`] = point.z_score
        rows.set(point.bucket, row)
      }
    }
    const sorted = Array.from(rows.values()).sort((left, right) =>
      String(left.bucket).localeCompare(String(right.bucket)),
    ) as Array<Record<string, string | number | boolean> & { bucket: string }>
    return padRows(sorted, { from, to }, granularity, bucket => ({ bucket }))
  }, [chartSeries, from, to, granularity])
  const { ref: containerRef, ready: containerReady } = useChartContainerReady()
  const yAxisWidth = useMemo(
    () => axisWidthForValues(collectMultiSeriesYValues(chartData), valueFormatter ?? formatCount),
    [chartData, valueFormatter],
  )
  const xAxisTicks = useTimeAxisTicks(chartData, granularity)
  const descId = useId()

  if (!chartSeries.length || !chartData.length) {
    return (
      <div className={cn('flex items-center justify-center text-muted-foreground text-body', className)} style={{ height }}>
        {emptyLabel}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={`${seriesNounPlural(seriesLabel)} breakdown over time`}
      // role="img" makes its children presentational, so the summary is only
      // read through this reference (DS-25).
      aria-describedby={descId}
      className={cn('w-full', className)}
      style={{ height }}
    >
      <div id={descId} className="sr-only">
        <p>Chart with {chartSeries.length} series: {chartSeries.map(s => s.label).join(', ')}.</p>
        {chartSeries.map(item => {
          const anomalies = item.data.filter(point => point.is_anomaly)
          return anomalies.length > 0 ? (
            <p key={item.key}>{item.label}: {formatAnomalyCount(anomalies.length)}.</p>
          ) : null
        })}
      </div>
      {containerReady ? (
        <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={chartData}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          tabIndex={CHART_SURFACE_TAB_INDEX}
        >
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
          <XAxis
            dataKey="bucket"
            {...xAxisTicks}
            className="text-body-sm fill-muted-foreground"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <YAxis
            tickFormatter={valueFormatter ?? formatCount}
            className="text-body-sm fill-muted-foreground"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={yAxisWidth}
          />
          <Tooltip
            content={
              <MultiSeriesTooltip
                granularity={granularity}
                seriesLabel={seriesLabel}
                valueFormatter={valueFormatter}
                tooltipFormatter={tooltipFormatter}
              />
            }
          />
          {chartSeries.map(item => (
            <Line
              key={item.key}
              type="monotone"
              dataKey={item.key}
              name={item.label}
              stroke={item.color}
              strokeWidth={item.isHighlighted ? 3 : 2}
              strokeOpacity={item.isHighlighted ? 1 : 0.82}
              strokeDasharray={item.dash}
              // Static, like the main volume series: animating up to eight
              // lines of a few hundred points each janked every range change
              // (MON-23).
              isAnimationActive={false}
              // The dot renderer runs once per point, so a series with nothing
              // flagged skips it entirely instead of drawing empty fragments.
              dot={!item.hasAnomaly ? false : (props: { cx?: number; cy?: number; payload?: Record<string, unknown> }) => {
                if (!props.payload?.[`${item.key}__anomaly`]) return <></>
                const direction = props.payload[`${item.key}__direction`]
                return (
                  <AnomalyMark
                    cx={props.cx}
                    cy={props.cy}
                    direction={direction === 'spike' || direction === 'drop' ? direction : null}
                    mini={false}
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

// The main volume series keeps `isAnimationActive={false}`, matching the band /
// forecast series above. MetricsChart mounts its ResponsiveContainer only once
// `useChartContainerReady` reports a real size (and TabMetricsCard nests it in a
// Collapsible), so recharts sees a late/resizing mount — exactly the case where
// an *animated* Area/Line can settle into its empty enter-frame and never paint.
// When the series is count-only (the events-metrics `events_total` response has
// no expected/band series to fall back on) that left the whole plot blank while
// the axes still rendered from the count domain (tripl-yfsj.2).
// Exported for unit tests only — recharts never paints in jsdom, so the
// animation flag is asserted on the returned element rather than on pixels.
// eslint-disable-next-line react-refresh/only-export-components
export function renderCountSeries({
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
    return (
      <AnomalyMark
        cx={props.cx}
        cy={props.cy}
        direction={props.payload.anomaly_direction}
        mini={mini}
      />
    )
  }

  if (chartStyle === 'bar') {
    return (
      <Bar
        dataKey="count"
        fill={chartColor}
        radius={[2, 2, 0, 0]}
        isAnimationActive={false}
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
        isAnimationActive={false}
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
      isAnimationActive={false}
      dot={anomalyDot}
      activeDot={mini ? false : { r: 4, strokeWidth: 0 }}
    />
  )
}

/**
 * An anomaly's mark on the line: a triangle pointing the way it moved, in the
 * direction's colour — so a drop reads as a drop without colour, and a spike
 * and a drop are told apart at a glance (MON-17). A plain dot, as before, when
 * the direction is unknown.
 */
// Exported for unit tests only — recharts never paints in jsdom.
export function AnomalyMark({
  cx,
  cy,
  direction,
  mini,
}: {
  cx?: number
  cy?: number
  direction?: 'spike' | 'drop' | null
  mini: boolean
}) {
  if (cx === undefined || cy === undefined) return <></>
  const r = mini ? 3.5 : 5
  const strokeWidth = mini ? 1.5 : 2
  if (!direction) {
    return (
      <circle
        cx={cx}
        cy={cy}
        r={mini ? 3 : 4}
        fill="var(--destructive)"
        stroke="var(--background)"
        strokeWidth={strokeWidth}
        data-testid="anomaly-dot"
      />
    )
  }
  const tip = direction === 'spike' ? cy - r : cy + r
  const base = direction === 'spike' ? cy + r * 0.7 : cy - r * 0.7
  return (
    <polygon
      points={`${cx},${tip} ${cx - r},${base} ${cx + r},${base}`}
      fill={signalDirectionColor(direction)}
      stroke="var(--background)"
      strokeWidth={strokeWidth}
      strokeLinejoin="round"
      data-testid="anomaly-dot"
      data-direction={direction}
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
  if (!payload?.is_anomaly) {
    return <rect x={x} y={y} width={width} height={height} fill={chartColor} rx={2} ry={2} />
  }
  // Fill AND an outline in the direction's colour: a changed fill alone was the
  // only cue, and at a bar's width a red and an amber fill are hard to tell
  // apart from the series colour (MON-17).
  const tone = payload.anomaly_direction
    ? signalDirectionColor(payload.anomaly_direction)
    : 'var(--destructive)'
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      fill={tone}
      fillOpacity={0.55}
      stroke={tone}
      strokeWidth={2}
      rx={2}
      ry={2}
      data-testid="anomaly-bar"
      data-direction={payload.anomaly_direction ?? undefined}
    />
  )
}

export function MiniMetricsChart({
  data,
  className,
  color,
  height = 72,
  label,
}: MiniMetricsChartProps) {
  const { chartStyle } = useTheme()
  const chartColor = color || SINGLE_SERIES_COLOR
  const gradientId = useId().replace(/:/g, '')
  const descId = useId()
  // Same gate as the full-size charts: a mini chart inside a collapsed card
  // mounted recharts at -1×-1 and logged a warning on every render (DS-27).
  const { ref: containerRef, ready: containerReady } = useChartContainerReady()

  if (!data.length) {
    return (
      <div
        className={cn('flex items-center justify-center text-caption text-muted-foreground', className)}
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
      ref={containerRef}
      role="img"
      aria-label={chartLabel}
      aria-describedby={descId}
      className={cn('w-full', className)}
      style={{ height }}
    >
      <span id={descId} className="sr-only">
        {data.length} data points{anomalyCount > 0 ? `, ${formatAnomalyCount(anomalyCount)}` : ''}.
      </span>
      {containerReady ? (
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 4, right: 2, bottom: 2, left: 2 }}
          tabIndex={CHART_SURFACE_TAB_INDEX}
        >
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
      ) : null}
    </div>
  )
}
