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

import { MetricsChart } from './chart'

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
