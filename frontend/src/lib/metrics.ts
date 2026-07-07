import type { EventMetricPoint } from '@/types'

export type MetricsGranularity = 'hour' | 'day' | 'week' | 'month'

export const RANGE_OPTIONS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
] as const

export const GRANULARITY_OPTIONS: { value: MetricsGranularity; label: string }[] = [
  { value: 'hour', label: 'Hours' },
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

export function getBucketStart(dateStr: string, granularity: MetricsGranularity): string {
  const date = new Date(dateStr)
  let normalized: Date

  switch (granularity) {
    case 'hour':
      normalized = new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours(),
      ))
      break
    case 'day':
      normalized = new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
      ))
      break
    case 'week': {
      // Anchor weekly buckets to the Unix epoch (1970-01-01, a Thursday) on a
      // fixed 7-day grid, matching the backend stores
      // (toStartOfInterval(col, INTERVAL 7 day) / date_bin(INTERVAL 7 day,
      // ..., epoch)). Floor the UTC midnight of this day to that grid so chart
      // weeks line up with server-computed anomaly buckets.
      const dayStartMs = Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
      )
      const WEEK_MS = 7 * 24 * 60 * 60 * 1000
      normalized = new Date(Math.floor(dayStartMs / WEEK_MS) * WEEK_MS)
      break
    }
    case 'month':
      normalized = new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        1,
      ))
      break
  }

  return normalized.toISOString()
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
