import { render, screen, waitFor } from '@testing-library/react'
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

function heatmap(
  cells: SeasonalityCell[],
  overrides: Partial<SeasonalityHeatmap> = {},
): SeasonalityHeatmap {
  const counts = cells.map(item => item.count)
  return {
    scan_config_id: 'scan-1',
    scope_type: 'event',
    scope_ref: 'e1',
    cells,
    max_count: counts.length ? Math.max(...counts) : 0,
    total_count: counts.reduce((sum, value) => sum + value, 0),
    interval: '1h',
    hourly_resolution: true,
    ...overrides,
  }
}

const WEEK_WINDOW = { from: '2026-01-01T00:00:00', to: '2026-01-08T00:00:00' }

function heatmapTree(
  client: QueryClient,
  rangeDays = 7,
  timeRange: { from: string; to: string } = WEEK_WINDOW,
) {
  return (
    <QueryClientProvider client={client}>
      <SeasonalityHeatmapComponent
        slug="demo"
        scanConfigId="scan-1"
        scopeType="event"
        scopeRef="e1"
        rangeDays={rangeDays}
        timeRange={timeRange}
      />
    </QueryClientProvider>
  )
}

function renderHeatmap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(heatmapTree(client))
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

  it('says the ramp is a rank scale, not a linear count scale (tripl-jfm3.127)', async () => {
    vi.mocked(metricsApi.getSeasonalityHeatmap).mockResolvedValue(
      heatmap([
        cell({ weekday: 0, hour: 0, count: 50 }),
        cell({ weekday: 3, hour: 14, count: 800 }),
      ]),
    )

    renderHeatmap()

    // The min/max labels are true endpoints, but the shading in between is by
    // quantile rank — the legend used to read as "events / slot" alone, which
    // invites reading a mid-tone as a mid-count.
    expect(await screen.findByText(/shaded by rank/)).toBeInTheDocument()
  })

  it('does not draw a grid a coarse interval can never fill (tripl-jfm3.128)', async () => {
    // A daily scan floors every bucket into hour 0, so 23 of each row's 24
    // cells are structurally empty and the grid reads as missing data.
    vi.mocked(metricsApi.getSeasonalityHeatmap).mockResolvedValue(
      heatmap([cell({ weekday: 0, hour: 0, count: 500 })], {
        interval: '1d',
        hourly_resolution: false,
      }),
    )

    const { container } = renderHeatmap()

    expect(await screen.findByText(/no hour-of-day detail/)).toBeInTheDocument()
    expect(screen.getByText('1d')).toBeInTheDocument()
    expect(container.querySelector('table')).toBeNull()
  })

  it('keys on the range length, not the live window that steps every few minutes (MON-3)', async () => {
    const fetchHeatmap = vi.mocked(metricsApi.getSeasonalityHeatmap)
    fetchHeatmap.mockReset()
    fetchHeatmap.mockResolvedValue(heatmap([cell({ weekday: 0, hour: 0, count: 5 })]))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(heatmapTree(client))
    await screen.findByText('Hour × weekday heatmap')
    expect(fetchHeatmap).toHaveBeenCalledTimes(1)

    // The live bound moved five minutes: same range, no refetch.
    rerender(heatmapTree(client, 7, { from: '2026-01-01T00:05:00', to: '2026-01-08T00:05:00' }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fetchHeatmap).toHaveBeenCalledTimes(1)

    // A new range refetches, and reads the window current at fetch time.
    const monthWindow = { from: '2025-12-09T00:05:00', to: '2026-01-08T00:05:00' }
    rerender(heatmapTree(client, 30, monthWindow))
    await waitFor(() => expect(fetchHeatmap).toHaveBeenCalledTimes(2))
    expect(fetchHeatmap).toHaveBeenLastCalledWith('demo', 'scan-1', expect.objectContaining(monthWindow))
  })
})
