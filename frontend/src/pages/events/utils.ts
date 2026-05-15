import type {
  EventMetricPoint,
  EventType,
  MetaFieldDefinition,
  MonitoringSignal,
  Variable,
} from '@/types'
import type { MetricsGranularity } from '@/lib/metrics'

export const TAB_METRICS_RANGE_DAYS_DEFAULT = 7
export const ROW_METRICS_RANGE_HOURS = 48
export const ROW_METRICS_LABEL = `${ROW_METRICS_RANGE_HOURS}h`

export const TAB_METRICS_RANGE_OPTIONS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
] as const

export const TAB_METRICS_GRANULARITY_OPTIONS: { value: MetricsGranularity; label: string }[] = [
  { value: 'hour', label: 'Hours' },
  { value: 'day', label: 'Days' },
  { value: 'week', label: 'Weeks' },
  { value: 'month', label: 'Months' },
]

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

export const LAST_SEEN_COL_KEY = 'last_seen'

export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never'
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return 'never'
  const diffSec = Math.max(0, Math.round((now - ts) / 1000))
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  const days = Math.floor(diffSec / 86400)
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

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

export function getMonitoringPath(slug: string, signal: MonitoringSignal) {
  if (signal.scope_type === 'project_total') {
    return `/p/${slug}/monitoring/project-total/${signal.scope_ref}`
  }
  if (signal.scope_type === 'event_type') {
    return `/p/${slug}/monitoring/event-type/${signal.scope_ref}`
  }
  return `/p/${slug}/monitoring/event/${signal.scope_ref}`
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
