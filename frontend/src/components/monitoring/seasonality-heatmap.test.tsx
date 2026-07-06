import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import { metricsApi } from '@/api/metrics'
import type { SeasonalityCell, SeasonalityHeatmap } from '@/types/metrics'

import { SeasonalityHeatmap as SeasonalityHeatmapComponent } from './seasonality-heatmap'

vi.mock('@/api/metrics', () => ({
  metricsApi: { getSeasonalityHeatmap: vi.fn() },
}))

function cell(
  overrides: Partial<SeasonalityCell> &
    Pick<SeasonalityCell, 'weekday' | 'hour' | 'count'>,
): SeasonalityCell {
  return { anomaly_count: 0, ...overrides }
}

function heatmap(cells: SeasonalityCell[]): SeasonalityHeatmap {
  const counts = cells.map(item => item.count)
  return {
    scan_config_id: 'scan-1',
    scope_type: 'event',
    scope_ref: 'e1',
    cells,
    max_count: counts.length ? Math.max(...counts) : 0,
    total_count: counts.reduce((sum, value) => sum + value, 0),
  }
}

function renderHeatmap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SeasonalityHeatmapComponent
        slug="demo"
        scanConfigId="scan-1"
        scopeType="event"
        scopeRef="e1"
        from="2026-01-01T00:00:00"
        to="2026-01-08T00:00:00"
      />
    </QueryClientProvider>,
  )
}

describe('SeasonalityHeatmap', () => {
  it('paints very different counts with visibly different fills', async () => {
    vi.mocked(metricsApi.getSeasonalityHeatmap).mockResolvedValue(
      heatmap([
        cell({ weekday: 0, hour: 0, count: 50 }),
        cell({ weekday: 3, hour: 14, count: 800 }),
      ]),
    )

    const { container } = renderHeatmap()

    await screen.findByText('Hour × weekday heatmap')

    const low = container.querySelector<HTMLElement>('[data-count="50"]')
    const high = container.querySelector<HTMLElement>('[data-count="800"]')
    expect(low).not.toBeNull()
    expect(high).not.toBeNull()

    const lowOpacity = Number(low?.style.opacity)
    const highOpacity = Number(high?.style.opacity)
    // A 16x volume swing must be plainly visible, not a near-uniform tint.
    expect(highOpacity).toBeGreaterThan(lowOpacity + 0.3)
  })

  it('renders a legend showing the min and max slot volumes', async () => {
    vi.mocked(metricsApi.getSeasonalityHeatmap).mockResolvedValue(
      heatmap([
        cell({ weekday: 0, hour: 0, count: 50 }),
        cell({ weekday: 3, hour: 14, count: 800 }),
      ]),
    )

    renderHeatmap()

    await screen.findByText('Hour × weekday heatmap')
    expect(screen.getByText('50')).toBeInTheDocument()
    expect(screen.getByText('800')).toBeInTheDocument()
  })
})
