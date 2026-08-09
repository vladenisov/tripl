import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import { metricsApi } from '@/api/metrics'
import type { TopMoverItem } from '@/types'

import { TopMoversPanel } from './top-movers-panel'

vi.mock('@/api/metrics', () => ({
  metricsApi: { getTopMovers: vi.fn(), getBreakdownSeries: vi.fn() },
}))

function mover(overrides: Partial<TopMoverItem> = {}): TopMoverItem {
  return {
    breakdown_column: 'platform',
    breakdown_value: 'ios',
    is_other: false,
    actual_count: 240,
    expected_count: 100,
    stddev: 12,
    z_score: 11.7,
    direction: 'spike',
    ...overrides,
  }
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TopMoversPanel
        slug="demo"
        scanConfigId="scan-1"
        scopeType="event"
        scopeRef="event-1"
        bucket="2026-01-02T00:00:00Z"
      />
    </QueryClientProvider>,
  )
}

describe('TopMoversPanel', () => {
  it('shows the signed percentage for a row that has a baseline', async () => {
    vi.mocked(metricsApi.getTopMovers).mockResolvedValue([mover()])
    renderPanel()

    expect(await screen.findByText('+140%')).toBeInTheDocument()
    expect(screen.queryByText('no baseline')).not.toBeInTheDocument()
  })

  it('says there is no baseline instead of leaving the cell blank (tripl-l429.27)', async () => {
    // A brand-new breakdown value: nothing was expected, so the ratio is
    // undefined. The row used to render an empty span, which reads as missing
    // data — indistinguishable from a value the panel simply failed to load.
    vi.mocked(metricsApi.getTopMovers).mockResolvedValue([
      mover({ breakdown_value: 'visionos', actual_count: 137, expected_count: 0, z_score: 9.1 }),
    ])
    renderPanel()

    const label = await screen.findByText('no baseline')
    expect(label).toHaveAttribute(
      'title',
      'No baseline to compare against for this breakdown value',
    )
    // The absolute move is what there is to report, and it stays beside it.
    expect(screen.getByText('+137')).toBeInTheDocument()
  })

  it('still prints nothing for a real change too small to round to a percent', async () => {
    // The two cases used to share the empty string. This one genuinely has
    // nothing to add: the absolute-delta badge beside it already says +0.
    vi.mocked(metricsApi.getTopMovers).mockResolvedValue([
      mover({ actual_count: 1000, expected_count: 999, z_score: 3.2 }),
    ])
    renderPanel()

    expect(await screen.findByText('+1')).toBeInTheDocument()
    expect(screen.queryByText('no baseline')).not.toBeInTheDocument()
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument()
  })
})
