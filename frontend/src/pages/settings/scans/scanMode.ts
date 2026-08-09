import type { ChipTone } from '@/components/primitives/chip'
import type { ScanConfig } from '@/types'

/**
 * A scan's operating mode, derived from the two columns the dispatcher itself
 * filters on (worker/tasks/metrics/schedule.py:349-350). Deliberately THREE
 * states: collapsing to two would render an interval-without-time-column config
 * as "Catalog only", laundering the CLI's scan_config_not_dispatchable FAIL
 * into a feature.
 *
 * Nothing persists this. Monitoring is not stored intent anywhere in tripl — it
 * *is* the runtime predicate `time_column IS NOT NULL AND interval IS NOT NULL`,
 * which the dispatcher, the metrics tasks, the scan service and the CLI's
 * `is_dispatchable` already evaluate. A `mode` column would be a cache of a
 * derivation no part of the pipeline reads.
 */
export type ScanMode = 'monitoring' | 'catalog' | 'misconfigured'

/**
 * The subset a user can pick in the form. `misconfigured` is a rendering state
 * for saved configs only and is never selectable — a saved misconfigured config
 * opens the form on "monitoring" with its empty Time column flagged, so saving
 * the form fixes it.
 */
export type ScanFormMode = Exclude<ScanMode, 'misconfigured'>

export function scanModeOf(
  config: Pick<ScanConfig, 'time_column' | 'interval'>,
): ScanMode {
  const hasTime = Boolean(config.time_column)
  const hasInterval = Boolean(config.interval)
  if (hasTime && hasInterval) return 'monitoring'
  if (hasInterval) return 'misconfigured' // interval, no time column
  return 'catalog' // both empty, or a time column without a schedule
}

/** The mode a saved config's edit form should open on. */
export function formModeOf(config: ScanConfig | null): ScanFormMode {
  if (!config) return 'monitoring'
  return scanModeOf(config) === 'catalog' ? 'catalog' : 'monitoring'
}

/**
 * Badge shown first on a scan's badge strip and on its list row.
 *
 * The fault has to be readable AS a fault. "No metrics collected" was true of a
 * catalog-only scan too, so a list holding both badges gave a reader no way to
 * tell the choice from the defect — the tone and a hover `title` were the only
 * difference, and a tooltip is invisible on touch. `Needs a time column` is the
 * diagnosis and the fix in three words, and cannot be misread as a mode.
 *
 * The `title` says what a manual run still does, because it still does it:
 * `trigger_scan` has no dispatchability guard (the guard is on
 * `trigger_metrics_replay` alone), so **Run now** works on this config and the
 * page underneath lists its green runs. "It is never run" is the one claim the
 * scan's own page falsifies.
 */
export const SCAN_MODE_BADGE: Record<ScanMode, { label: string; tone: ChipTone; title: string }> = {
  monitoring: {
    label: 'Monitoring',
    tone: 'accent',
    title: 'Collects metric points on a schedule.',
  },
  catalog: {
    label: 'Catalog only',
    tone: 'neutral',
    title: 'Adds events and fields to your tracking plan. No metric points, no anomalies,'
      + ' no alerts.',
  },
  misconfigured: {
    label: 'Needs a time column',
    tone: 'warning',
    title:
      'This scan has a schedule but no time column, so the scheduler never runs it and it'
      + ' collects no metric points. Runs you start by hand still add events to your plan.'
      + ' Add a time column to fix it.',
  },
}

/**
 * Value of the `Mode` row in the scan detail's "Source & query" panel.
 *
 * `misconfigured` gets its own wording rather than a "Catalog only" prefix: the
 * Mode row is where a user goes to check what their scan is doing, and printing
 * the healthy mode's name there is exactly the laundering the header comment
 * above rules out. It is not catalog-only — a catalog-only scan is a choice, and
 * this one asked for a schedule and never got one.
 */
export const SCAN_MODE_DETAIL_LABEL: Record<ScanMode, string> = {
  monitoring: 'Catalog + monitoring',
  catalog: 'Catalog only',
  misconfigured: 'Never runs on its schedule — schedule set but no time column',
}
