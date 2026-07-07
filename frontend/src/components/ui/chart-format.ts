// Pure tick/axis-sizing helpers for the chart components. Kept out of chart.tsx
// so that file exports only components (react-refresh/only-export-components);
// chart.tsx and the chart tests import these.

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
