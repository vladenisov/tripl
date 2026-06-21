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
      const expectedCount = bucketPoints.every(point => point.expected_count === null)
        ? null
        : bucketPoints.reduce((sum, point) => sum + (point.expected_count ?? 0), 0)
      // Buckets are treated as independent samples, so variance adds —
      // stddev for the aggregate is sqrt(Σ σᵢ²). Null when no source
      // bucket carried a stddev.
      const stddev = bucketPoints.every(point => point.stddev === null)
        ? null
        : Math.sqrt(
            bucketPoints.reduce((sum, point) => {
              const s = point.stddev ?? 0
              return sum + s * s
            }, 0),
          )

      return {
        bucket,
        count: bucketPoints.reduce((sum, point) => sum + point.count, 0),
        expected_count: expectedCount,
        stddev,
        is_anomaly: strongestAnomaly !== undefined,
        anomaly_direction: strongestAnomaly?.anomaly_direction ?? null,
        z_score: strongestAnomaly?.z_score ?? null,
      }
    })
}
