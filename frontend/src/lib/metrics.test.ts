import { describe, expect, it } from 'vitest'
import type { EventMetricPoint } from '@/types'
import { aggregateMetricPoints, getBucketStart } from './metrics'

function point(overrides: Partial<EventMetricPoint> & { bucket: string }): EventMetricPoint {
  return {
    count: 0,
    expected_count: null,
    stddev: null,
    is_anomaly: false,
    anomaly_direction: null,
    z_score: null,
    ...overrides,
  }
}

describe('getBucketStart', () => {
  it('floors to the start of the UTC hour', () => {
    expect(getBucketStart('2026-06-10T13:47:31.500Z', 'hour'))
      .toBe('2026-06-10T13:00:00.000Z')
  })

  it('floors to the start of the UTC day', () => {
    expect(getBucketStart('2026-06-10T13:47:31.500Z', 'day'))
      .toBe('2026-06-10T00:00:00.000Z')
  })

  it('floors to the first of the UTC month', () => {
    expect(getBucketStart('2026-06-10T13:47:31.500Z', 'month'))
      .toBe('2026-06-01T00:00:00.000Z')
  })

  // Week start is Monday via (getUTCDay()+6)%7. 2026-06-08 is a Monday.
  it('keeps a Monday as its own week start', () => {
    expect(getBucketStart('2026-06-08T10:00:00Z', 'week'))
      .toBe('2026-06-08T00:00:00.000Z')
  })

  it('rolls a mid-week day back to the preceding Monday', () => {
    // 2026-06-10 is a Wednesday -> back to Monday 2026-06-08.
    expect(getBucketStart('2026-06-10T23:59:59Z', 'week'))
      .toBe('2026-06-08T00:00:00.000Z')
  })

  it('rolls Sunday back to the preceding Monday (not forward)', () => {
    // 2026-06-14 is a Sunday -> Monday 2026-06-08, six days earlier.
    expect(getBucketStart('2026-06-14T12:00:00Z', 'week'))
      .toBe('2026-06-08T00:00:00.000Z')
  })

  it('crosses a month boundary when the Monday is in the previous month', () => {
    // 2026-07-01 is a Wednesday -> Monday 2026-06-29.
    expect(getBucketStart('2026-07-01T00:00:00Z', 'week'))
      .toBe('2026-06-29T00:00:00.000Z')
  })
})

describe('aggregateMetricPoints', () => {
  it('groups points into buckets and sums counts, returning sorted buckets', () => {
    const result = aggregateMetricPoints(
      [
        point({ bucket: '2026-06-10T11:30:00Z', count: 5 }),
        point({ bucket: '2026-06-10T10:00:00Z', count: 2 }),
        point({ bucket: '2026-06-10T10:45:00Z', count: 3 }),
      ],
      'hour',
    )
    expect(result.map(p => p.bucket)).toEqual([
      '2026-06-10T10:00:00.000Z',
      '2026-06-10T11:00:00.000Z',
    ])
    expect(result[0].count).toBe(5)
    expect(result[1].count).toBe(5)
  })

  it('adds variance across buckets: stddev = sqrt(sum of squares)', () => {
    const result = aggregateMetricPoints(
      [
        point({ bucket: '2026-06-10T10:00:00Z', count: 1, stddev: 3 }),
        point({ bucket: '2026-06-10T10:30:00Z', count: 1, stddev: 4 }),
      ],
      'hour',
    )
    // sqrt(3^2 + 4^2) = sqrt(25) = 5
    expect(result).toHaveLength(1)
    expect(result[0].stddev).toBe(5)
  })

  it('returns null stddev when every source bucket has null stddev', () => {
    const result = aggregateMetricPoints(
      [
        point({ bucket: '2026-06-10T10:00:00Z', count: 1, stddev: null }),
        point({ bucket: '2026-06-10T10:30:00Z', count: 2, stddev: null }),
      ],
      'hour',
    )
    expect(result[0].stddev).toBeNull()
  })

  it('treats all-zero stddevs as zero, not null', () => {
    const result = aggregateMetricPoints(
      [
        point({ bucket: '2026-06-10T10:00:00Z', count: 1, stddev: 0 }),
        point({ bucket: '2026-06-10T10:30:00Z', count: 2, stddev: 0 }),
      ],
      'hour',
    )
    expect(result[0].stddev).toBe(0)
  })

  it('returns null expected_count only when every source is null', () => {
    const mixed = aggregateMetricPoints(
      [
        point({ bucket: '2026-06-10T10:00:00Z', expected_count: null }),
        point({ bucket: '2026-06-10T10:30:00Z', expected_count: 7 }),
      ],
      'hour',
    )
    expect(mixed[0].expected_count).toBe(7)

    const allNull = aggregateMetricPoints(
      [
        point({ bucket: '2026-06-10T10:00:00Z', expected_count: null }),
        point({ bucket: '2026-06-10T10:30:00Z', expected_count: null }),
      ],
      'hour',
    )
    expect(allNull[0].expected_count).toBeNull()
  })

  it('selects the strongest anomaly by absolute z-score within a bucket', () => {
    const result = aggregateMetricPoints(
      [
        point({
          bucket: '2026-06-10T10:00:00Z',
          is_anomaly: true,
          anomaly_direction: 'drop',
          z_score: -2,
        }),
        point({
          bucket: '2026-06-10T10:30:00Z',
          is_anomaly: true,
          anomaly_direction: 'spike',
          z_score: 5,
        }),
        point({
          bucket: '2026-06-10T10:45:00Z',
          is_anomaly: false,
          z_score: 100,
        }),
      ],
      'hour',
    )
    expect(result[0].is_anomaly).toBe(true)
    expect(result[0].z_score).toBe(5)
    expect(result[0].anomaly_direction).toBe('spike')
  })

  it('picks the largest magnitude even when the strongest is negative', () => {
    const result = aggregateMetricPoints(
      [
        point({
          bucket: '2026-06-10T10:00:00Z',
          is_anomaly: true,
          anomaly_direction: 'drop',
          z_score: -8,
        }),
        point({
          bucket: '2026-06-10T10:30:00Z',
          is_anomaly: true,
          anomaly_direction: 'spike',
          z_score: 3,
        }),
      ],
      'hour',
    )
    expect(result[0].z_score).toBe(-8)
    expect(result[0].anomaly_direction).toBe('drop')
  })

  it('marks a bucket as non-anomalous when no source point is an anomaly', () => {
    const result = aggregateMetricPoints(
      [point({ bucket: '2026-06-10T10:00:00Z', count: 4, is_anomaly: false })],
      'hour',
    )
    expect(result[0].is_anomaly).toBe(false)
    expect(result[0].z_score).toBeNull()
    expect(result[0].anomaly_direction).toBeNull()
  })
})
