import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts')
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  }
})

import { metricAxisFormatter } from '@/lib/metricFormat'
import type { EventMetricPoint } from '@/types'
import { buildChartData, CustomTooltip, MetricsChart, MultiSeriesTooltip } from './chart'

describe('MetricsChart', () => {
  it('renders anomaly dots for anomalous points', () => {
    render(
      <MetricsChart
        granularity="day"
        data={[
          {
            bucket: '2026-01-01T10:00:00Z',
            count: 10,
            expected_count: null,
            stddev: null,
            is_anomaly: false,
            anomaly_direction: null,
            z_score: null,
          },
          {
            bucket: '2026-01-02T10:00:00Z',
            count: 0,
            expected_count: 10,
            stddev: 2,
            is_anomaly: true,
            anomaly_direction: 'drop',
            z_score: -10,
          },
        ]}
      />,
    )

    expect(screen.getByTestId('anomaly-dot')).toBeInTheDocument()
  })

  it('snaps annotations to the nearest bucket and exposes them for screen readers', () => {
    render(
      <MetricsChart
        granularity="hour"
        data={[
          {
            bucket: '2026-01-01T10:00:00Z',
            count: 10,
            expected_count: null,
            stddev: null,
            is_anomaly: false,
            anomaly_direction: null,
            z_score: null,
          },
          {
            bucket: '2026-01-01T11:00:00Z',
            count: 12,
            expected_count: null,
            stddev: null,
            is_anomaly: false,
            anomaly_direction: null,
            z_score: null,
          },
        ]}
        annotations={[
          {
            id: 'a1',
            project_id: 'proj',
            scope_type: null,
            scope_ref: null,
            // Closer to the 11:00 bucket than the 10:00 one — should snap to 11:00.
            bucket: '2026-01-01T10:45:00Z',
            label: 'v1.4 deploy',
            description: null,
            color: '#ef4444',
            created_by_user_id: null,
            created_at: '2026-01-01T09:00:00Z',
          },
        ]}
      />,
    )

    const marker = screen.getByTestId('chart-annotation')
    expect(marker.textContent).toContain('2026-01-01T11:00:00Z')
    expect(marker.textContent).toContain('v1.4 deploy')
  })

  it('exposes forecast points in the sr-only summary when provided', () => {
    render(
      <MetricsChart
        granularity="hour"
        data={[
          {
            bucket: '2026-01-01T10:00:00Z',
            count: 10,
            expected_count: 9,
            stddev: 2,
            is_anomaly: false,
            anomaly_direction: null,
            z_score: null,
          },
        ]}
        forecast={[
          {
            bucket: '2026-01-01T11:00:00Z',
            expected_count: 12,
            stddev: 2,
          },
        ]}
      />,
    )

    const marker = screen.getByTestId('forecast-point')
    expect(marker.textContent).toContain('2026-01-01T11:00:00Z')
    expect(marker.textContent).toContain('12')
  })
})

// The tooltip never paints under jsdom (recharts needs real dimensions), so
// the valueFormatter threading is covered on the exported tooltip directly.
describe('CustomTooltip', () => {
  const point = {
    bucket: '2026-01-01T10:00:00Z',
    count: 0.08,
    expected_count: 0.05,
    stddev: 0.01,
    band: [0.03, 0.07] as [number, number],
  }

  it('keeps the default raw value + series label without a formatter', () => {
    render(
      <CustomTooltip
        active
        payload={[{ value: 0.08, payload: point }]}
        label="2026-01-01T10:00:00Z"
        granularity="hour"
        seriesLabel="%"
      />,
    )

    expect(screen.getByText('0.08 %')).toBeInTheDocument()
    expect(screen.getByText('Expected: 0')).toBeInTheDocument()
  })

  it('routes value, expected, band, and deviation through valueFormatter', () => {
    render(
      <CustomTooltip
        active
        payload={[{ value: 0.08, payload: point }]}
        label="2026-01-01T10:00:00Z"
        granularity="hour"
        seriesLabel="%"
        valueFormatter={metricAxisFormatter('%')}
      />,
    )

    expect(screen.getByText('8%')).toBeInTheDocument()
    expect(screen.getByText('Expected: 5%')).toBeInTheDocument()
    // Default sigma threshold is 3 when none is served.
    expect(screen.getByText('±3σ band: 3%–7%')).toBeInTheDocument()
    expect(screen.getByText('Deviation: +3%')).toBeInTheDocument()
  })

  it('labels the band with the served sigma threshold', () => {
    render(
      <CustomTooltip
        active
        payload={[{ value: 0.08, payload: point }]}
        label="2026-01-01T10:00:00Z"
        granularity="hour"
        seriesLabel="%"
        valueFormatter={metricAxisFormatter('%')}
        sigmaThreshold={2.5}
      />,
    )

    expect(screen.getByText('±2.5σ band: 3%–7%')).toBeInTheDocument()
  })
})

// Same jsdom constraint as CustomTooltip: the breakdown/version tooltip is
// verified directly. Percent-unit catalog metrics store fractions, so without
// a formatter the old hardcoded `value.toLocaleString() events` rendered
// "0.081 events" (tripl-4dej).
describe('MultiSeriesTooltip', () => {
  const payload = [
    { value: 0.081, dataKey: 'series_0', color: '#111111', name: 'ios' },
    { value: 0.05, dataKey: 'series_1', color: '#222222', name: 'android' },
  ]

  it('keeps the default `value seriesLabel` lines without a formatter', () => {
    render(
      <MultiSeriesTooltip
        active
        payload={payload}
        label="2026-01-01T10:00:00Z"
        granularity="hour"
        seriesLabel="events"
      />,
    )

    expect(screen.getByText('0.081 events')).toBeInTheDocument()
    expect(screen.getByText('0.05 events')).toBeInTheDocument()
  })

  it('routes series values through valueFormatter and drops the label suffix', () => {
    render(
      <MultiSeriesTooltip
        active
        payload={payload}
        label="2026-01-01T10:00:00Z"
        granularity="hour"
        seriesLabel="%"
        valueFormatter={metricAxisFormatter('%')}
      />,
    )

    // Stored fractions render ×100 with the formatter's own unit…
    expect(screen.getByText('8.1%')).toBeInTheDocument()
    expect(screen.getByText('5%')).toBeInTheDocument()
    // …and the seriesLabel suffix disappears entirely.
    expect(screen.queryByText(/events/)).not.toBeInTheDocument()
  })
})

describe('buildChartData confidence band', () => {
  // A flagged bucket: actual 0 vs expected 10 with effective stddev 2. The
  // detector served `stddev` as the FLOORED effective stddev, so the band is
  // expected ± sigmaThreshold * stddev.
  const flagged: EventMetricPoint = {
    bucket: '2026-01-02T10:00:00Z',
    count: 0,
    expected_count: 10,
    stddev: 2,
    is_anomaly: true,
    anomaly_direction: 'drop',
    z_score: -5,
  }
  const normal: EventMetricPoint = {
    bucket: '2026-01-01T10:00:00Z',
    count: 10,
    expected_count: null,
    stddev: null,
    is_anomaly: false,
    anomaly_direction: null,
    z_score: null,
  }

  it('draws the band as expected ± sigmaThreshold * effective_stddev', () => {
    const [built] = buildChartData([flagged], [], 3)
    expect(built.band).toEqual([10 - 3 * 2, 10 + 3 * 2])
  })

  it('scales the band width with the served sigma threshold', () => {
    const [narrow] = buildChartData([flagged], [], 2)
    const [wide] = buildChartData([flagged], [], 4)
    expect(narrow.band).toEqual([6, 14])
    expect(wide.band).toEqual([2, 18])
  })

  it('keeps a flagged point outside the band and leaves normal buckets bandless', () => {
    const [built] = buildChartData([flagged], [], 3)
    const [lower, upper] = built.band as [number, number]
    // actual 0 sits below the lower band edge -> visually "flagged".
    expect(flagged.count).toBeLessThan(lower)
    expect(upper).toBeGreaterThan(lower)

    const [normalPoint] = buildChartData([normal], [], 3)
    expect(normalPoint.band).toBeUndefined()
  })

  it('falls back to the default multiplier for a missing/invalid threshold', () => {
    const [built] = buildChartData([flagged], [], Number.NaN)
    expect(built.band).toEqual([10 - 3 * 2, 10 + 3 * 2])
  })
})
