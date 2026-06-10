import { describe, expect, it } from 'vitest'
import type { EventMetricPoint, MonitoringSignal } from '@/types'
import {
  deriveRowSignalFromMetrics,
  formatRelativeTime,
  mapLatestSignals,
  pickLatestSignal,
} from './utils'

function metricPoint(
  overrides: Partial<EventMetricPoint> & { bucket: string },
): EventMetricPoint {
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

function signal(overrides: Partial<MonitoringSignal>): MonitoringSignal {
  return {
    scan_config_id: 'scan-1',
    scope_type: 'event',
    scope_ref: 'evt-1',
    state: 'recent',
    event_id: 'evt-1',
    event_type_id: null,
    bucket: '2026-06-10T00:00:00Z',
    actual_count: 0,
    expected_count: 0,
    stddev: 0,
    z_score: 0,
    direction: 'drop',
    ...overrides,
  }
}

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-06-10T12:00:00Z')

  it('returns "never" for missing or unparseable input', () => {
    expect(formatRelativeTime(null, now)).toBe('never')
    expect(formatRelativeTime(undefined, now)).toBe('never')
    expect(formatRelativeTime('not-a-date', now)).toBe('never')
  })

  it('returns "just now" below the 60s threshold', () => {
    expect(formatRelativeTime('2026-06-10T11:59:01Z', now)).toBe('just now')
    expect(formatRelativeTime('2026-06-10T11:59:00Z', now)).toBe('1m ago')
  })

  it('crosses minute/hour/day boundaries correctly', () => {
    expect(formatRelativeTime('2026-06-10T11:00:01Z', now)).toBe('59m ago')
    expect(formatRelativeTime('2026-06-10T11:00:00Z', now)).toBe('1h ago')
    expect(formatRelativeTime('2026-06-09T12:00:01Z', now)).toBe('23h ago')
    expect(formatRelativeTime('2026-06-09T12:00:00Z', now)).toBe('1d ago')
  })

  it('clamps future timestamps to "just now"', () => {
    expect(formatRelativeTime('2026-06-10T12:05:00Z', now)).toBe('just now')
  })

  it('rolls up into months and years', () => {
    expect(formatRelativeTime('2026-05-01T12:00:00Z', now)).toBe('1mo ago')
    expect(formatRelativeTime('2025-01-01T12:00:00Z', now)).toBe('1y ago')
  })
})

describe('pickLatestSignal', () => {
  it('returns the most recent signal of the requested scope', () => {
    const result = pickLatestSignal(
      [
        signal({ scope_type: 'event', scope_ref: 'a', bucket: '2026-06-08T00:00:00Z' }),
        signal({ scope_type: 'event', scope_ref: 'b', bucket: '2026-06-10T00:00:00Z' }),
        signal({ scope_type: 'event_type', scope_ref: 'c', bucket: '2026-06-12T00:00:00Z' }),
      ],
      'event',
    )
    expect(result?.scope_ref).toBe('b')
  })

  it('returns null when no signal matches the scope', () => {
    expect(pickLatestSignal([signal({ scope_type: 'event' })], 'project_total')).toBeNull()
  })
})

describe('mapLatestSignals', () => {
  it('keeps only the latest signal per scope_ref for the scope type', () => {
    const map = mapLatestSignals(
      [
        signal({ scope_ref: 'a', bucket: '2026-06-08T00:00:00Z', z_score: 1 }),
        signal({ scope_ref: 'a', bucket: '2026-06-10T00:00:00Z', z_score: 9 }),
        signal({ scope_ref: 'b', bucket: '2026-06-09T00:00:00Z', z_score: 4 }),
        signal({ scope_type: 'event_type', scope_ref: 'a', bucket: '2026-06-30T00:00:00Z' }),
      ],
      'event',
    )
    expect(map.size).toBe(2)
    expect(map.get('a')?.z_score).toBe(9)
    expect(map.get('b')?.z_score).toBe(4)
  })
})

describe('deriveRowSignalFromMetrics', () => {
  it('returns null when there are no directional anomalies', () => {
    expect(
      deriveRowSignalFromMetrics('evt-1', 'scan-1', [
        metricPoint({ bucket: '2026-06-10T00:00:00Z', is_anomaly: false }),
        metricPoint({ bucket: '2026-06-10T01:00:00Z', is_anomaly: true, anomaly_direction: null }),
      ]),
    ).toBeNull()
  })

  it('flags latest_scan when the anomaly is the final bucket', () => {
    const result = deriveRowSignalFromMetrics('evt-1', 'scan-1', [
      metricPoint({ bucket: '2026-06-10T00:00:00Z', count: 5 }),
      metricPoint({
        bucket: '2026-06-10T01:00:00Z',
        count: 1,
        expected_count: 9,
        is_anomaly: true,
        anomaly_direction: 'drop',
        z_score: -4,
      }),
    ])
    expect(result).toMatchObject({
      scope_ref: 'evt-1',
      scope_type: 'event',
      state: 'latest_scan',
      actual_count: 1,
      expected_count: 9,
      z_score: -4,
      direction: 'drop',
      bucket: '2026-06-10T01:00:00Z',
    })
  })

  it('flags recent when a later non-anomalous bucket follows the anomaly', () => {
    const result = deriveRowSignalFromMetrics('evt-1', undefined, [
      metricPoint({
        bucket: '2026-06-10T00:00:00Z',
        is_anomaly: true,
        anomaly_direction: 'spike',
        z_score: 6,
      }),
      metricPoint({ bucket: '2026-06-10T01:00:00Z', is_anomaly: false }),
    ])
    expect(result?.state).toBe('recent')
    expect(result?.scan_config_id).toBe('')
  })

  it('falls back to actual count for expected_count when null', () => {
    const result = deriveRowSignalFromMetrics('evt-1', 'scan-1', [
      metricPoint({
        bucket: '2026-06-10T00:00:00Z',
        count: 3,
        expected_count: null,
        is_anomaly: true,
        anomaly_direction: 'spike',
        z_score: null,
      }),
    ])
    expect(result?.expected_count).toBe(3)
    expect(result?.z_score).toBe(0)
  })
})
