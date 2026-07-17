// Pure tick/axis-sizing helpers for the chart components. Kept out of chart.tsx
// so that file exports only components (react-refresh/only-export-components);
// chart.tsx and the chart tests import these.

import type { MetricsGranularity } from '@/lib/metrics'

// Bucket starts are UTC instants (see getBucketStart / backend bucketing.py), so
// every label is rendered in UTC. Formatting them in the viewer's local timezone
// would print a Monday week bucket as "Week of Sun Jun 7" west of Greenwich and
// a day bucket under the wrong date entirely — the axis would disagree with the
// bucket the server actually computed (tripl-64n8.2).
const UTC = 'UTC'

export function formatTick(dateStr: string, granularity: MetricsGranularity): string {
  const d = new Date(dateStr)

  switch (granularity) {
    // A 15-minute bucket needs its minutes on the axis: without them, the four
    // buckets of an hour all render as the same tick.
    case '15min':
      return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: UTC,
      })
    case 'hour':
    case '6h':
      return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        timeZone: UTC,
      })
    case 'day':
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: UTC })
    case 'week':
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: UTC })
    case 'month':
      return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: UTC })
  }
}

export function formatTooltipLabel(dateStr: string, granularity: MetricsGranularity): string {
  const d = new Date(dateStr)

  switch (granularity) {
    case '15min':
    case 'hour':
    case '6h':
      return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: UTC,
      })
    case 'day':
      return d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: UTC,
      })
    case 'week':
      return `Week of ${d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: UTC,
      })}`
    case 'month':
      return d.toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: UTC,
      })
  }
}

// Pluralization-aware anomaly-count sentence shared by every chart sr-only
// summary (single-series, multi-series, compact) so the singular/plural split is
// defined once. "1 anomaly detected" vs "N anomalies detected" — never the
// broken "1 anomalies detected".
export function formatAnomalyCount(count: number): string {
  return count === 1 ? '1 anomaly detected' : `${count} anomalies detected`
}

// Cap for how many humanized bucket labels a screen-reader summary enumerates
// before collapsing the tail into "and N more". Keeps the sr-only text from
// reading out dozens of timestamps one by one.
const BUCKET_PREVIEW_LIMIT = 5

// Humanize a list of bucket instants into a short, comma-separated preview for
// sr-only text. Reuses formatTooltipLabel so raw ISO strings never surface, and
// bounds the enumeration to the first BUCKET_PREVIEW_LIMIT entries, appending
// "and N more" for the remainder.
export function summarizeBuckets(
  buckets: string[],
  granularity: MetricsGranularity,
  max: number = BUCKET_PREVIEW_LIMIT,
): string {
  if (buckets.length === 0) return ''
  const shown = buckets.slice(0, max).map(bucket => formatTooltipLabel(bucket, granularity))
  const remaining = buckets.length - shown.length
  const preview = shown.join(', ')
  return remaining > 0 ? `${preview}, and ${remaining} more` : preview
}

// Collapse a forecast series (one bucket per point) into a single humanized
// range ("Forecast from <start> to <end>") instead of one span per bucket.
export function summarizeForecastRange(
  buckets: string[],
  granularity: MetricsGranularity,
): string {
  if (buckets.length === 0) return ''
  const start = formatTooltipLabel(buckets[0], granularity)
  if (buckets.length === 1) return `Forecast for ${start}`
  const end = formatTooltipLabel(buckets[buckets.length - 1], granularity)
  return `Forecast from ${start} to ${end}`
}

// Compact axis/tick labels that never blow out the reserved Y-axis width:
// 380000 -> "380k", 1_500_000 -> "1.5M", 1_000_000 -> "1M". Whole numbers at
// >= 100 of a unit, one decimal (trailing .0 stripped) below, so a label stays
// <= ~5 characters across the 100k–9.9M range instead of the old "380.0k"
// (6 chars) that clipped its left digits against a fixed 48px axis.
//
// Sub-1000 values are ROUNDED, not stringified verbatim: a fractional
// confidence-band bound like -0.99 would otherwise render as
// "-0.9900000000000001" (19 chars of float noise), which the axis-width probe
// below turned into a ~140px Y-axis that shoved the whole plot right.
export function formatCount(value: number): string {
  const abs = Math.abs(value)
  // 999_500 already rounds up to "1M" — escalate before it renders "1000k".
  if (abs >= 999_500) return `${compactUnit(value / 1_000_000)}M`
  if (abs >= 1_000) return `${compactUnit(value / 1_000)}k`
  return String(Math.round(value))
}

function compactUnit(scaled: number): number {
  return Math.abs(scaled) >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10
}

// Approximate advance width (px) of one tick character at `text-xs` (12px) in
// the default sans stack — digits/'k'/'M'/'%' average out a touch under this.
const Y_AXIS_CHAR_PX = 7.4
// Gap between the (hidden) tick line and the label — matches YAxis tickMargin.
const Y_AXIS_TICK_MARGIN = 8
// Breathing room so the leftmost digit never touches the chart edge.
const Y_AXIS_PADDING = 8
// Never dip below recharts' comfortable default for 1–2 char labels.
const Y_AXIS_MIN_WIDTH = 40
// Hard ceiling so a pathological label (float noise, NaN/Infinity, or an
// oversized custom formatter) can never reserve a Y-axis wide enough to shove
// the plot area sideways. A compact count/percent label tops out near 6 chars
// (~61px), so 80px leaves headroom without ever eating the chart.
const Y_AXIS_MAX_WIDTH = 80

/**
 * Reserve a Y axis wide enough for the widest tick label the axis will paint,
 * measured through the ACTIVE formatter (compact counts, or a caller's percent
 * formatter). Fixes 6-digit labels ("380k") clipping their left digits when the
 * axis width was a fixed 48px. Probes the domain extremes plus a 10% overshoot
 * to catch the "nice" tick recharts rounds up to above the data max.
 */
export function axisWidthForValues(
  values: number[],
  formatter: (value: number) => string,
): number {
  if (!values.length) return Y_AXIS_MIN_WIDTH
  let min = values[0]
  let max = values[0]
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  // The ±10% overshoot anticipates the "nice" tick recharts rounds up to above
  // the data max. Skip non-finite probes so NaN/Infinity can't reach the
  // formatter and produce a garbage-length label.
  const candidates = [min, max, max * 1.1, min * 1.1].filter(Number.isFinite)
  let maxLen = 0
  for (const candidate of candidates) {
    const len = formatter(candidate).length
    if (len > maxLen) maxLen = len
  }
  const width = Math.ceil(Y_AXIS_TICK_MARGIN + maxLen * Y_AXIS_CHAR_PX + Y_AXIS_PADDING)
  return Math.min(Y_AXIS_MAX_WIDTH, Math.max(Y_AXIS_MIN_WIDTH, width))
}
