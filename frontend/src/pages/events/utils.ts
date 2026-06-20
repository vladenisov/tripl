import { arrayMove } from '@dnd-kit/sortable'
import type {
  EventMetricPoint,
  EventType,
  MetaFieldDefinition,
  MonitoringSignal,
  Variable,
} from '@/types'
import { GRANULARITY_OPTIONS, RANGE_OPTIONS } from '@/lib/metrics'

export const TAB_METRICS_RANGE_DAYS_DEFAULT = 7
export const ROW_METRICS_RANGE_HOURS = 48
export const ROW_METRICS_LABEL = `${ROW_METRICS_RANGE_HOURS}h`

export const TAB_METRICS_RANGE_OPTIONS = RANGE_OPTIONS
export const TAB_METRICS_GRANULARITY_OPTIONS = GRANULARITY_OPTIONS

// Stable empty references — lets the consumers feed through `??` without
// minting a new array/object every render and busting React.memo.
export const EMPTY_EVENT_TYPES: EventType[] = []
export const EMPTY_META_FIELDS: MetaFieldDefinition[] = []
export const EMPTY_VARIABLES: Variable[] = []
export const EMPTY_TAGS: string[] = []
export const EMPTY_SIGNALS: MonitoringSignal[] = []
export const EMPTY_EVENT_WINDOW_METRICS: {
  event_id: string
  scan_config_id: string | null
  interval: string
  total_count: number
  data: EventMetricPoint[]
}[] = []
export const EMPTY_WINDOW_POINTS: EventMetricPoint[] = []

const compactCountFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 0,
})

export function formatCompactCount(value: number) {
  return compactCountFormatter.format(value).toLowerCase()
}

/**
 * Compute the new row order produced by a drag-reorder.
 *
 * When `activeId` belongs to a multi-row selection, the whole selection moves
 * as a contiguous block to the drop target, preserving the selected rows'
 * relative order. Otherwise a single row moves. Returns `null` when there is
 * nothing to apply — unknown ids, a no-op drop, or the block dropped onto one
 * of its own rows.
 */
export function reorderWithSelection(
  ids: string[],
  selectedSet: Set<string>,
  activeId: string,
  overId: string,
): string[] | null {
  if (activeId === overId) return null
  const oldIndex = ids.indexOf(activeId)
  const newIndex = ids.indexOf(overId)
  if (oldIndex < 0 || newIndex < 0) return null

  const isMultiDrag = selectedSet.size > 1 && selectedSet.has(activeId)
  if (!isMultiDrag) {
    return arrayMove(ids, oldIndex, newIndex)
  }

  const movingIds = ids.filter((id) => selectedSet.has(id))
  const remaining = ids.filter((id) => !selectedSet.has(id))
  const overInRemaining = remaining.indexOf(overId)
  if (overInRemaining < 0) return null // dropped onto another selected row
  const insertAt = oldIndex < newIndex ? overInRemaining + 1 : overInRemaining
  return [
    ...remaining.slice(0, insertAt),
    ...movingIds,
    ...remaining.slice(insertAt),
  ]
}

export const LAST_SEEN_COL_KEY = 'last_seen'

export { formatRelativeTime } from '@/lib/datetime'

export function getSignalTone(signal: MonitoringSignal) {
  if (signal.state === 'latest_scan') {
    return {
      compact: 'text-destructive',
      regular: 'bg-destructive text-destructive-foreground',
      button: 'destructive' as const,
      buttonClassName: '',
      title: 'Open latest scan anomaly',
    }
  }

  return {
    compact: 'text-amber-500',
    regular: 'bg-amber-400 text-amber-950 ring-1 ring-amber-500/70',
    button: 'outline' as const,
    buttonClassName: 'border-amber-500/60 bg-amber-400/15 text-amber-800 hover:bg-amber-400/20',
    title: 'Open recent anomaly',
  }
}

export function pickLatestSignal(
  signals: MonitoringSignal[],
  scopeType: MonitoringSignal['scope_type'],
) {
  return signals
    .filter(signal => signal.scope_type === scopeType)
    .sort((left, right) => right.bucket.localeCompare(left.bucket))[0] ?? null
}

export function mapLatestSignals(
  signals: MonitoringSignal[],
  scopeType: MonitoringSignal['scope_type'],
) {
  const entries = new Map<string, MonitoringSignal>()
  signals
    .filter(signal => signal.scope_type === scopeType)
    .sort((left, right) => right.bucket.localeCompare(left.bucket))
    .forEach(signal => {
      if (!entries.has(signal.scope_ref)) entries.set(signal.scope_ref, signal)
    })
  return entries
}

export function deriveRowSignalFromMetrics(
  eventId: string,
  scanConfigId: string | null | undefined,
  points: EventMetricPoint[],
): MonitoringSignal | null {
  const anomalyPoints = points.filter(
    point => point.is_anomaly && point.anomaly_direction !== null,
  )
  if (!anomalyPoints.length) return null

  const latestAnomaly = anomalyPoints[anomalyPoints.length - 1]
  const latestBucket = points[points.length - 1]?.bucket ?? latestAnomaly.bucket

  return {
    scan_config_id: scanConfigId ?? '',
    scope_type: 'event',
    scope_ref: eventId,
    state: latestAnomaly.bucket === latestBucket ? 'latest_scan' : 'recent',
    event_id: eventId,
    event_type_id: null,
    bucket: latestAnomaly.bucket,
    actual_count: latestAnomaly.count,
    expected_count: latestAnomaly.expected_count ?? latestAnomaly.count,
    stddev: 0,
    z_score: latestAnomaly.z_score ?? 0,
    direction: latestAnomaly.anomaly_direction ?? 'drop',
  }
}
