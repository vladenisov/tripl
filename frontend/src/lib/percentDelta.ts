/**
 * How a percent delta is written, everywhere it is shown.
 *
 * The percent gate deliberately admits anomalies with no baseline at all
 * (tripl-l429.12) — a scope resuming after an outage, an event firing for the
 * first time, a schema drift — and every one of those arrives with
 * `expected_count` 0. `percent_delta` is stored 0.0 for them because the ratio
 * is undefined and the column is NOT NULL, so printing it reported the largest
 * possible relative move as the smallest one (tripl-l429.24). The absolute delta
 * is what there is to report for that class, and it sits in its own column.
 *
 * Mirrors the backend's `alert_templates.format_percent_delta`, which fills the
 * `${percent_delta_label}` variable in the alert message. The two describe the
 * SAME stored row — the delivery item — so they have to say the same thing.
 */

/** What the percentage is called when there is nothing to divide by. */
export const NO_BASELINE_LABEL = 'no baseline'

export function formatPercentDelta(percentDelta: number, expectedCount: number): string {
  // `expectedCount > 0` is the exact condition under which the backend computed
  // the stored number, so the label and the number cannot disagree about
  // whether there was a baseline.
  if (expectedCount > 0) return `${percentDelta.toFixed(1)}%`
  return NO_BASELINE_LABEL
}

/**
 * The signed percentage a value moved against its baseline, or `null` when there
 * is no baseline to divide by.
 *
 * For the surfaces that hold the two counts and compute the ratio themselves —
 * a top-mover row, a monitoring signal banner — rather than reading a stored
 * `percent_delta`. Same `expected > 0` gate as {@link formatPercentDelta} and
 * the backend's `alert_templates`, so no surface can decide on its own that a
 * zero baseline is a baseline.
 */
export function ratioDelta(actual: number, expected: number): number | null {
  if (!(expected > 0)) return null
  return ((actual - expected) / expected) * 100
}

/**
 * {@link ratioDelta} written for display: a signed percentage, or the words
 * `no baseline`.
 *
 * An undefined ratio is named, never dropped: a blank cell reads as missing
 * data, which is a different (and fixable) problem from one that is undefined by
 * definition (tripl-l429.27).
 */
export function formatRatioDelta(percent: number | null, digits = 0): string {
  if (percent === null) return NO_BASELINE_LABEL
  return `${percent > 0 ? '+' : ''}${percent.toFixed(digits)}%`
}
