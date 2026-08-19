/**
 * The one definition of "how big is this signal", shared by every surface that
 * reports an open-signal count.
 *
 * These numbers used to live in each page. They drifted twice: the sidebar badge
 * disagreed with the Anomalies page (tripl-yfsj.1), and after that was fixed for
 * three surfaces the top-bar bell was left behind on a different query entirely
 * (tripl-jfm3.89). A shared module makes "the counts agree" the default rather
 * than something four call sites have to remember.
 *
 * The magnitude itself is no longer mirrored: the backend ships
 * ``relative_effect`` on each signal and this module reads it, so the sidebar's
 * ``monitoring_signal_count`` and this gate cannot disagree by construction.
 * Only the THRESHOLD is still duplicated, in
 * ``services/metrics_insights_service.SIGNIFICANT_MIN_REL_EFFECT``.
 */
import type { MonitoringSignal } from '@/types'

/**
 * Relative effect: |actual − expected| / max(expected, 1).
 *
 * Preferred over the z-score for user-facing filtering because z is inflated on
 * low-volume series, letting a tiny absolute change on a quiet scope outrank a
 * large one on a busy scope.
 */
export function relativeEffect(signal: MonitoringSignal): number {
  // The server computes this now and ships it on the signal. It is the only
  // side that knows whether a catalog metric's series is count-shaped, and a
  // fractional one must NOT have its denominator floored at 1 — a ratio
  // expected at 0.12 and observed at 0.04 scored 0.08 here and never cleared
  // the bar below, so metric anomalies were invisible at the default level
  // (tripl-yf8c). Recomputing locally is also what let this formula drift from
  // the backend's twice before (tripl-yfsj.1, tripl-jfm3.89).
  //
  // The fallback stays for payloads that carry no value — it is the old
  // count-shaped estimate, correct for every scope except a fractional metric.
  if (signal.relative_effect !== null && signal.relative_effect !== undefined) {
    return signal.relative_effect
  }
  return Math.abs(signal.actual_count - signal.expected_count) / Math.max(signal.expected_count, 1)
}

/** The "Significant" bar (±50%): the AnomaliesPage default and the badge gate. */
export const SIGNIFICANT_MIN_REL_EFFECT = 0.5

export const MAGNITUDE_PRESETS = [
  { id: 'all', label: 'All', minRelEffect: 0 },
  { id: 'significant', label: 'Significant', minRelEffect: SIGNIFICANT_MIN_REL_EFFECT },
  { id: 'major', label: 'Major', minRelEffect: 1 },
] as const

export type MagnitudeLevel = (typeof MAGNITUDE_PRESETS)[number]['id']

/** Default to "Significant" so a flooded list is usable without touching the filter. */
export const DEFAULT_MAGNITUDE_LEVEL: MagnitudeLevel = 'significant'

/**
 * The significant open signals, biggest effect first.
 *
 * Callers MUST pass the EXPANDED signal list (`getActiveSignals(slug, undefined,
 * { expanded: true })`). The collapsed variant queries only project_total and
 * event_type scopes, so an incident made purely of event-scope anomalies is not
 * rolled up into a parent — it is dropped, and the count silently reads zero
 * during a live incident (tripl-jfm3.89).
 *
 * `filter` returns a fresh array, so the `sort` never mutates a React Query cache.
 */
export function selectSignificantSignals(
  signals: readonly MonitoringSignal[] | undefined,
): MonitoringSignal[] {
  return (signals ?? [])
    .filter(signal => relativeEffect(signal) >= SIGNIFICANT_MIN_REL_EFFECT)
    .sort((a, b) => relativeEffect(b) - relativeEffect(a))
}
