import type { EventMetricPoint } from '@/types'

/**
 * Chart granularities. `15min` and `6h` exist so that every *collection* interval
 * the backend supports (`15m`, `1h`, `6h`, `1d`, `1w` — see
 * backend/src/tripl/core/intervals.py) has a chart granularity that matches it.
 * Without them a 15m or 6h metric charted under an "Hours" label, naming the axis
 * after a bucket width the data does not have (tripl-64n8.15).
 */
export type MetricsGranularity = '15min' | 'hour' | '6h' | 'day' | 'week' | 'month'

export const RANGE_OPTIONS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
] as const

export const GRANULARITY_OPTIONS: { value: MetricsGranularity; label: string }[] = [
  { value: '15min', label: '15 min' },
  { value: 'hour', label: 'Hours' },
  { value: '6h', label: '6 hours' },
  { value: 'day', label: 'Days' },
  { value: 'week', label: 'Weeks' },
  { value: 'month', label: 'Months' },
]

/**
 * Default chart granularity for a selected day-range, sized so the series stays
 * readable instead of collapsing into an unreadable comb. Hourly buckets over a
 * month are ~720 points; following the range keeps the point count in the tens.
 *
 * Used as the *default* only — a manual granularity pick overrides it and stays
 * sticky across range changes. Catalog-metric drilldowns bypass this and follow
 * their collection interval instead (see MonitoringDetailPage).
 */
export function defaultGranularityForRange(rangeDays: number): MetricsGranularity {
  if (rangeDays <= 7) return 'hour'
  if (rangeDays <= 30) return 'day'
  return 'week'
}

const MINUTE_MS = 60 * 1000
const QUARTER_HOUR_MS = 15 * MINUTE_MS
const HOUR_MS = 60 * MINUTE_MS
const SIX_HOUR_MS = 6 * HOUR_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

/**
 * Anchor for sub-week buckets: the Unix epoch, 1970-01-01T00:00:00Z. Mirrors
 * `EPOCH` in backend/src/tripl/core/bucketing.py — hour and day divide a UTC day
 * evenly, so an epoch anchor lands every boundary on a natural clock boundary.
 */
const EPOCH_MS = 0

/**
 * Anchor for week buckets: 1970-01-05T00:00:00Z, the first Monday at or after
 * the epoch. Mirrors `WEEK_ORIGIN` in backend/src/tripl/core/bucketing.py.
 *
 * Weeks start on MONDAY. Binning weeks straight off the epoch — which is what
 * this module used to do — starts them on a THURSDAY, because 1970-01-01 was a
 * Thursday. The warehouse adapters all say "Monday" explicitly (`toMonday` /
 * `TIMESTAMP_TRUNC(..., WEEK(MONDAY))` / `date_bin` off this origin), so the
 * epoch grid put every chart week three days ahead of the server-computed
 * bucket it was supposed to line up with (tripl-64n8.2).
 */
const WEEK_ORIGIN_MS = Date.UTC(1970, 0, 5)

/**
 * Floor `ms` onto a fixed-width grid of `sizeMs` cells measured from `originMs`.
 * `Math.floor` rounds toward -Infinity, so timestamps before the origin floor
 * backwards rather than toward it.
 */
function floorToGrid(ms: number, sizeMs: number, originMs: number): number {
  return originMs + Math.floor((ms - originMs) / sizeMs) * sizeMs
}

/**
 * Floor an ISO timestamp to the start of its bucket, as an ISO UTC string.
 *
 * This is the frontend half of the bucket contract in
 * backend/src/tripl/core/bucketing.py, and must agree with `floor_to_bucket`
 * for the same instant. Everything is UTC — deliberately no local-time date
 * math anywhere below, or a user in UTC+14 would floor a timestamp into a
 * different bucket than the one the server computed and stored.
 */
export function getBucketStart(dateStr: string, granularity: MetricsGranularity): string {
  const ms = new Date(dateStr).getTime()

  switch (granularity) {
    // 15 min, 1h and 6h all divide a UTC day evenly, so an epoch anchor puts every
    // boundary on a natural clock boundary — and lands on the same grid the backend
    // bins to (sub-week buckets are epoch-anchored there too).
    case '15min':
      return new Date(floorToGrid(ms, QUARTER_HOUR_MS, EPOCH_MS)).toISOString()
    case 'hour':
      return new Date(floorToGrid(ms, HOUR_MS, EPOCH_MS)).toISOString()
    case '6h':
      return new Date(floorToGrid(ms, SIX_HOUR_MS, EPOCH_MS)).toISOString()
    case 'day':
      return new Date(floorToGrid(ms, DAY_MS, EPOCH_MS)).toISOString()
    case 'week':
      return new Date(floorToGrid(ms, WEEK_MS, WEEK_ORIGIN_MS)).toISOString()
    case 'month': {
      // Months are calendar units, not a fixed-width grid, so they can't be
      // binned off an origin. Still UTC-only. (The backend has no month
      // interval; this granularity is a chart-side rollup.)
      const date = new Date(ms)
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString()
    }
  }
}

/**
 * Re-flag an aggregated bucket only when the *rolled-up* count is itself
 * significant against the rolled-up baseline. Kept in line with the detector's
 * sigma_threshold (~3, see website/docs/use/anomaly-detection.md) so a single
 * anomalous hour cannot redden a day/week bucket that is otherwise
 * unremarkable — often the lowest point of the week (tripl-dmch.10).
 */
const AGGREGATE_ANOMALY_Z_THRESHOLD = 3

export function aggregateMetricPoints(
  points: EventMetricPoint[],
  granularity: MetricsGranularity,
): EventMetricPoint[] {
  const grouped = new Map<string, EventMetricPoint[]>()

  for (const point of points) {
    const bucket = getBucketStart(point.bucket, granularity)
    const existing = grouped.get(bucket) ?? []
    existing.push(point)
    grouped.set(bucket, existing)
  }

  return Array.from(grouped.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([bucket, bucketPoints]) => {
      const strongestAnomaly = bucketPoints
        .filter(point => point.is_anomaly)
        .sort((left, right) => Math.abs(right.z_score ?? 0) - Math.abs(left.z_score ?? 0))[0]

      const count = bucketPoints.reduce((sum, point) => sum + point.count, 0)

      // Only roll up a baseline when *every* source bucket carries one.
      // Summing a partial set (e.g. only the single scored/anomalous hour)
      // against a full-count aggregate produces an expected ~1/N of the count
      // and a nonsensical tooltip, so drop expected/stddev instead of
      // reporting a corrupt one (tripl-dmch.10).
      const hasFullExpected = bucketPoints.every(point => point.expected_count !== null)
      const expectedCount = hasFullExpected
        ? bucketPoints.reduce((sum, point) => sum + (point.expected_count ?? 0), 0)
        : null
      // Buckets are treated as independent samples, so variance adds —
      // stddev for the aggregate is sqrt(Σ σᵢ²). Null unless every source
      // bucket carried a stddev.
      const hasFullStddev = bucketPoints.every(point => point.stddev !== null)
      const stddev = hasFullStddev
        ? Math.sqrt(
            bucketPoints.reduce((sum, point) => {
              const s = point.stddev ?? 0
              return sum + s * s
            }, 0),
          )
        : null

      // Re-test significance at the aggregate level. Single buckets (and
      // groups with no coherent aggregate baseline) fall through to the
      // un-aggregated pass-through so hourly behavior is unchanged; multi-hour
      // rollups are re-flagged only when the total itself is significant. The
      // inline null checks also narrow expectedCount/stddev to numbers.
      let isAnomaly: boolean
      let zScore: number | null
      let anomalyDirection: EventMetricPoint['anomaly_direction']

      if (bucketPoints.length > 1 && expectedCount !== null && stddev !== null && stddev > 0) {
        const aggregateZ = (count - expectedCount) / stddev
        isAnomaly = Math.abs(aggregateZ) >= AGGREGATE_ANOMALY_Z_THRESHOLD
        zScore = isAnomaly ? aggregateZ : null
        anomalyDirection = isAnomaly ? (aggregateZ >= 0 ? 'spike' : 'drop') : null
      } else {
        isAnomaly = strongestAnomaly !== undefined
        zScore = strongestAnomaly?.z_score ?? null
        anomalyDirection = strongestAnomaly?.anomaly_direction ?? null
      }

      return {
        bucket,
        count,
        expected_count: expectedCount,
        stddev,
        is_anomaly: isAnomaly,
        anomaly_direction: anomalyDirection,
        z_score: zScore,
      }
    })
}
