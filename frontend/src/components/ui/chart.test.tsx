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
