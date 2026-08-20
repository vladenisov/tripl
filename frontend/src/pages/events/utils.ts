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

// Per-row queries key on the event ids they cover, so the ids are split into
// fixed-size, INDEX-ALIGNED buckets rather than sent as one accumulated list.
// With 200-row pages + infinite scroll, an all-ids key changed on every append
// and re-sent the entire set; bucketing keeps each already-loaded bucket's key
// (and cache entry) stable, so appending a page only fetches the new bucket.
// Window metrics were fixed this way in tripl-jfm3.51; the signals query next to
// them kept the accumulating key until tripl-jfm3.121.
export const EVENT_ID_BUCKET_SIZE = 100

export function chunkEventIds(eventIds: string[]): string[][] {
  const buckets: string[][] = []
  for (let start = 0; start < eventIds.length; start += EVENT_ID_BUCKET_SIZE) {
    buckets.push(eventIds.slice(start, start + EVENT_ID_BUCKET_SIZE))
  }
  return buckets
}
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

/**
 * Compact volume label for the 48h column — "505K", "4M".
 *
 * Case is load-bearing here and must NOT be lowercased: the neighbouring
 * "Last seen" cell renders relative durations ("1m ago", "1h ago") in a
 * similarly sized tabular-figure cell, so a lowercase "1m" volume under a
 * header that reads only "48h" invited a six-order-of-magnitude misread
 * (tripl-klfb). Uppercase M also matches every other count formatter in the
 * app (lib/metricFormat.ts, components/ui/chart-format.ts), including the
 * chart directly above this table.
 */
export function formatCompactCount(value: number): string {
  return compactCountFormatter.format(value)
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Width of the collection grid, read off the series instead of assumed. The
 * window-metrics endpoint returns stored EventMetric rows only — no zero fill —
 * so the smallest gap between consecutive buckets is the scan interval whenever
 * any two adjacent buckets survived. A gap-riddled series only inflates it,
 * which loosens the coverage check below rather than tightening it.
 */
function inferBucketMs(points: EventMetricPoint[]): number {
  let smallest = Number.POSITIVE_INFINITY
  for (let i = 1; i < points.length; i += 1) {
    const gap = Date.parse(points[i].bucket) - Date.parse(points[i - 1].bucket)
    if (gap > 0 && gap < smallest) smallest = gap
  }
  return Number.isFinite(smallest) ? smallest : 0
}

/**
 * 24h volume delta for a catalog row: percent change of the most recent 24h of
 * volume versus the prior 24h, read off the same window-metric series the event
 * detail page uses. Mirrors MonitoringDetailPage.computeEventStats so the list's
 * "Δ · 24h" column and the detail page agree (the previous implementation keyed
 * off per-bucket anomaly `expected_count`, which is null on non-anomaly buckets,
 * so nearly every row rendered "—"). Summing raw points equals summing an hourly
 * aggregation, so no pre-bucketing is needed.
 *
 * Returns null unless the series actually reaches back two full 24h windows
 * from its newest bucket. The fetch window is 48h anchored on NOW
 * (ROW_METRICS_RANGE_HOURS) while the comparison anchors on the newest bucket
 * that carries data, so a collection that lags clips the "prior" slot to
 * whatever still fits inside the window: on a stand whose newest bucket sat
 * ~22h behind now, every one of 13 rows divided 24h of volume by ~1.25h of it
 * and landed between +1673% and +1907% — a column that could not be sorted,
 * compared, or acted on, beside rows reading "last seen: never" (tripl-7vnw).
 * "No prior 24h window to compare against" is the honest answer there, and it
 * is already what the cell renders for null.
 */
export function computeWindowDelta(points: EventMetricPoint[]): number | null {
  if (points.length < 2) return null
  const latest = Date.parse(points[points.length - 1].bucket)
  const earliest = Date.parse(points[0].bucket)
  if (!Number.isFinite(latest) || !Number.isFinite(earliest)) return null
  // One bucket of slack: a fully covered 48h window puts its first and last
  // hourly bucket 47h apart, and a daily grid fits exactly two buckets in it.
  if (latest - earliest < 2 * DAY_MS - inferBucketMs(points)) return null
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

  // Soft fill rather than the solid amber this used to paint: the tone token
  // is the AA-safe ink for its own fill in both themes, whereas a solid needs a
  // foreground that flips with the theme. It also keeps the louder solid
  // treatment above exclusive to the latest scan, which is the urgent one.
  return {
    compact: 'text-warning',
    regular: 'bg-warning-soft text-warning ring-1 ring-warning/40',
    button: 'outline' as const,
    buttonClassName: 'border-warning/50 bg-warning-soft text-warning hover:bg-warning/20',
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
    // A per-event row signal is standalone here, never an incident rollup child.
    incident_child: false,
  }
}

// --- Glitchy / templated event-name + value rendering helpers (UX-9, UX-21) ---

export const NAME_SEGMENT_SEPARATOR = ':'
const TEMPLATE_TOKEN_SPLIT = /(\$\{[^}{]*\})/g
const TEMPLATE_TOKEN_MATCH = /^\$\{[^}{]*\}$/

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

export type ValuePart = { text: string; token: boolean; known?: boolean }

export type ResolvedTemplateToken = {
  token: string
  variable: Variable | null
}

/**
 * Resolve complete `${token}` placeholders against canonical variable names,
 * legacy scan identities, and user-configured bindings.
 */
export function resolveTemplateTokens(
  value: string,
  variables: Variable[],
): ResolvedTemplateToken[] {
  if (!value.includes('${')) return []

  const variablesByToken = new Map<string, Variable>()
  for (const variable of variables) {
    for (const token of [variable.name, variable.source_name, ...variable.bindings]) {
      if (token && !variablesByToken.has(token)) variablesByToken.set(token, variable)
    }
  }

  return value
    .split(TEMPLATE_TOKEN_SPLIT)
    .filter((part) => TEMPLATE_TOKEN_MATCH.test(part))
    .map((token) => ({
      token,
      variable: variablesByToken.get(token.slice(2, -1)) ?? null,
    }))
}

/**
 * Split a property value into plain-text and `${…}` template-token parts so the
 * tokens can be tinted to read as variables rather than literal text.
 */
export function splitTemplateValue(value: string, variables?: Variable[]): ValuePart[] {
  if (!value.includes('${')) return [{ text: value, token: false }]
  const knownByToken = variables
    ? new Map(resolveTemplateTokens(value, variables).map(({ token, variable }) => [token, variable !== null]))
    : null
  return value
    .split(TEMPLATE_TOKEN_SPLIT)
    .filter((p) => p !== '')
    .map((p) => {
      const token = TEMPLATE_TOKEN_MATCH.test(p)
      return {
        text: p,
        token,
        ...(token && knownByToken ? { known: knownByToken.get(p) ?? false } : {}),
      }
    })
}

/** Structural subset of Variable used by the ${} autocomplete surfaces. */
export interface VariableSuggestionShape {
  name: string
  description?: string
  bindings?: string[]
  allowed_values?: string[]
}

export function suggestionMatches(v: VariableSuggestionShape, filter: string): boolean {
  const needle = filter.toLowerCase()
  return (
    v.name.toLowerCase().includes(needle)
    || (v.description ?? '').toLowerCase().includes(needle)
    || (v.bindings ?? []).some(binding => binding.toLowerCase().includes(needle))
  )
}

const NAME_FORMAT_TOKEN = /\{([^}]+)\}/g

/**
 * Apply a scan `event_name_format` to entered field values (client mirror of
 * backend core/name_template.py). Dotted keys walk the field's JSON value;
 * unresolved keys stay literal `{key}` and are reported in `missing`.
 */
export function applyEventNameFormat(
  fmt: string,
  valuesByField: Record<string, string>,
): { name: string; missing: string[] } {
  const missing: string[] = []
  const name = fmt.replace(NAME_FORMAT_TOKEN, (whole, key: string) => {
    const direct = valuesByField[key]
    if (direct) return direct
    if (key.includes('.')) {
      const [column, ...segments] = key.split('.')
      const raw = valuesByField[column]
      if (raw) {
        try {
          let node: unknown = JSON.parse(raw)
          for (const segment of segments) {
            if (typeof node !== 'object' || node === null || Array.isArray(node)) {
              node = undefined
              break
            }
            node = (node as Record<string, unknown>)[segment]
          }
          if (node !== undefined && node !== null && typeof node !== 'object') return String(node)
        } catch {
          // unparseable (e.g. still ${templated}) — fall through to missing
        }
      }
    }
    missing.push(key)
    return whole
  })
  return { name, missing }
}
