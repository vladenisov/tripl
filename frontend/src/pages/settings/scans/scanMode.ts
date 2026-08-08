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

/** Badge shown first on a scan's badge strip and on its list row. */
export const SCAN_MODE_BADGE: Record<ScanMode, { label: string; tone: ChipTone; title: string }> = {
  monitoring: {
    label: 'Monitoring',
    tone: 'accent',
    title: 'Collects metric points on a schedule.',
  },
  catalog: {
    label: 'Catalog only',
    tone: 'neutral',
    title: 'Adds events to your plan. No metrics, no anomalies, no alerts.',
  },
  misconfigured: {
    label: 'No metrics collected',
    tone: 'warning',
    title:
      'This scan has a schedule but no time column, so it is never run. Add a time column to fix it.',
  },
}

/** Value of the `Mode` row in the scan detail's "Source & query" panel. */
export const SCAN_MODE_DETAIL_LABEL: Record<ScanMode, string> = {
  monitoring: 'Catalog + monitoring',
  catalog: 'Catalog only',
  misconfigured: 'Catalog only — schedule set but no time column',
}
