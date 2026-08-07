/**
 * How an alert item's percent delta is written, everywhere it is shown.
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
