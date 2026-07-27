import type { ReactElement, ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Props every ComposedChart was rendered with, so tests can assert on values
// that never reach the DOM under jsdom (recharts skips its <svg> without a
// measured container size).
const composedChartProps = vi.hoisted(() => [] as Record<string, unknown>[])

vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts')
  const ActualComposedChart = actual.ComposedChart
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ComposedChart: (props: Record<string, unknown>) => {
      composedChartProps.push(props)
      return <ActualComposedChart {...props} />
    },
  }
})

import { metricAxisFormatter } from '@/lib/metricFormat'
import type { EventMetricPoint } from '@/types'
import {
  buildChartData,
  CustomTooltip,
  MetricsChart,
  MultiSeriesTooltip,
  renderCountSeries,
} from './chart'

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

  it('summarizes forecast points as a humanized range in the sr-only summary', () => {
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
          {
            bucket: '2026-01-01T12:00:00Z',
            expected_count: 13,
            stddev: 2,
          },
        ]}
      />,
    )

    const marker = screen.getByTestId('forecast-point')
    // Collapsed into a start/end range, humanized — never one raw-ISO span per bucket.
    expect(marker.textContent).toContain('Forecast from')
    expect(marker.textContent).toContain('to')
    expect(marker.textContent).toContain('Jan 1')
    expect(marker.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('pluralizes the anomaly count and humanizes buckets in the sr-only summary', () => {
    const { rerender } = render(
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

    const singular = screen.getByTestId('anomaly-dot')
    // Singular wording for exactly one anomaly — never "1 anomalies".
    expect(singular.textContent).toContain('1 anomaly detected')
    expect(singular.textContent).not.toContain('1 anomalies')
    // Bucket is humanized, not a raw ISO instant abutting the sentence.
    expect(singular.textContent).toContain('Jan 2, 2026')
    expect(singular.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T/)

    rerender(
      <MetricsChart
        granularity="day"
        data={[
          {
            bucket: '2026-01-01T10:00:00Z',
            count: 0,
            expected_count: 10,
            stddev: 2,
            is_anomaly: true,
            anomaly_direction: 'drop',
            z_score: -10,
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

    const plural = screen.getByTestId('anomaly-dot')
    expect(plural.textContent).toContain('2 anomalies detected')
    expect(plural.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  // Regression for tripl-yfsj.2: the events-metrics `events_total` response is
  // count-only (no expected_count/stddev/band/forecast). MetricsChart must treat
  // it as a real, non-empty series (not the "No metrics data available" state) so
  // the volume series is charted — even when one bucket is a huge outlier that
  // drives the whole y-domain.
  it('charts a count-only (events_total) series instead of the empty state', () => {
    const countOnly: EventMetricPoint[] = [
      {
        bucket: '2026-01-01T10:00:00Z',
        count: 5000,
        expected_count: null,
        stddev: null,
        is_anomaly: false,
        anomaly_direction: null,
        z_score: null,
      },
      {
        // A large outlier bucket (e.g. a backfill) that drives the y-domain.
        bucket: '2026-01-01T11:00:00Z',
        count: 600000,
        expected_count: null,
        stddev: null,
        is_anomaly: true,
        anomaly_direction: 'spike',
        z_score: null,
      },
      {
        bucket: '2026-01-01T12:00:00Z',
        count: 4800,
        expected_count: null,
        stddev: null,
        is_anomaly: false,
        anomaly_direction: null,
        z_score: null,
      },
    ]

    render(<MetricsChart granularity="hour" data={countOnly} />)

    // Non-empty count-only data is charted, not dropped to the empty state…
    expect(screen.queryByText('No metrics data available')).not.toBeInTheDocument()
    // …and every bucket reaches the chart (sr-only summary), including the
    // flagged outlier.
    const summary = screen.getByTestId('anomaly-dot')
    expect(summary.textContent).toContain('1 anomaly detected')
  })
})

describe('renderCountSeries', () => {
  // jsdom never paints recharts, so the blank-on-late-mount fix is asserted on
  // the series element: the volume series must keep animation OFF so it renders
  // its final geometry immediately instead of settling into an empty enter-frame
  // when MetricsChart mounts late inside a Collapsible (tripl-yfsj.2).
  it.each(['line', 'line-only', 'bar'] as const)(
    'renders a non-animated count series for the %s chart style',
    (chartStyle) => {
      const series = renderCountSeries({
        chartStyle,
        chartColor: 'var(--chart-3)',
        gradientId: 'grad',
        mini: false,
      }) as ReactElement<{ dataKey: string; isAnimationActive: boolean }>

      expect(series.props.dataKey).toBe('count')
      expect(series.props.isAnimationActive).toBe(false)
    },
  )
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

describe('chart surface accessibility', () => {
  const point: EventMetricPoint = {
    bucket: '2026-01-01T10:00:00Z',
    count: 10,
    expected_count: null,
    stddev: null,
    is_anomaly: false,
    anomaly_direction: null,
    z_score: null,
  }

  it('keeps the recharts surface out of the tab order and names the wrapper', () => {
    // The chart only mounts its ResponsiveContainer once the wrapper measures
    // a positive size, and jsdom reports 0×0 for everything.
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 400, height: 200, x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 200, toJSON: () => ({}) })

    composedChartProps.length = 0
    const { container } = render(<MetricsChart granularity="day" data={[point]} />)
    rect.mockRestore()

    // Recharts focuses its <svg class="recharts-surface"> by default, which
    // added an unnamed tab stop on every charted page (tripl-jfm3.67).
    expect(composedChartProps).not.toHaveLength(0)
    for (const props of composedChartProps) {
      expect(props.tabIndex).toBe(-1)
    }

    // The accessible content lives on the wrapper, which stays named.
    const wrapper = container.querySelector('[role="img"]')
    expect(wrapper).toHaveAttribute('aria-label')
  })
})
