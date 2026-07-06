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

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 24h volume delta for a catalog row: percent change of the most recent 24h of
 * volume versus the prior 24h, read off the same window-metric series the event
 * detail page uses. Mirrors MonitoringDetailPage.computeEventStats so the list's
 * "Δ · 24h" column and the detail page agree (the previous implementation keyed
 * off per-bucket anomaly `expected_count`, which is null on non-anomaly buckets,
 * so nearly every row rendered "—"). Summing raw points equals summing an hourly
 * aggregation, so no pre-bucketing is needed. Returns null when there is no prior
 * 24h volume to compare against.
 */
export function computeWindowDelta(points: EventMetricPoint[]): number | null {
  if (points.length === 0) return null
  const latest = Date.parse(points[points.length - 1]?.bucket ?? '') || Date.now()
  let recent = 0
  let prior = 0
  for (const point of points) {
    const age = latest - Date.parse(point.bucket)
    if (age < DAY_MS) recent += point.count
    else if (age < 2 * DAY_MS) prior += point.count
  }
  if (prior <= 0) return null
  return ((recent - prior) / prior) * 100
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

// --- Glitchy / templated event-name + value rendering helpers (UX-9, UX-21) ---

export const NAME_SEGMENT_SEPARATOR = ':'
const TEMPLATE_TOKEN_SPLIT = /(\$\{[^}]*\})/g
const TEMPLATE_TOKEN_MATCH = /^\$\{[^}]*\}$/

export type NameSegment = { text: string; empty: boolean }

// An empty colon-segment can arrive as "" or as the serialized sentinel "0".
// Kept in sync with ReconciliationPage's DeadEventName so the events list and
// the reconciliation list render glitchy names identically.
function isEmptyNameSegment(segment: string): boolean {
  return segment === '' || segment === '0'
}

/**
 * Split a colon-namespaced event name into segments, but only when one of the
 * segments is empty (e.g. "spot::services"). A bare "::" reads as a rendering
 * bug, so the empty piece is surfaced as an intentional placeholder. Returns
 * `null` for ordinary names so they render unchanged.
 */
export function splitEventName(name: string): NameSegment[] | null {
  const parts = name.split(NAME_SEGMENT_SEPARATOR)
  if (parts.length === 1 || !parts.some(isEmptyNameSegment)) return null
  return parts.map((p) => ({ text: p, empty: isEmptyNameSegment(p) }))
}

export type ValuePart = { text: string; token: boolean }

/**
 * Split a property value into plain-text and `${…}` template-token parts so the
 * tokens can be tinted to read as variables rather than literal text.
 */
export function splitTemplateValue(value: string): ValuePart[] {
  if (!value.includes('${')) return [{ text: value, token: false }]
  return value
    .split(TEMPLATE_TOKEN_SPLIT)
    .filter((p) => p !== '')
    .map((p) => ({ text: p, token: TEMPLATE_TOKEN_MATCH.test(p) }))
}
