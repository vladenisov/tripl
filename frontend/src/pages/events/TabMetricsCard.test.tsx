import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TabMetricsCard } from './TabMetricsCard'

vi.mock('@/components/ui/chart-lazy', () => ({
  MetricsChart: ({ sigmaThreshold }: { sigmaThreshold?: number }) => (
    <div data-testid="metrics-chart" data-sigma-threshold={sigmaThreshold ?? ''} />
  ),
}))

function installFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input)
    if (url.includes('/api/v1/projects/demo/events-metrics')) {
      return new Response(
        JSON.stringify({
          scope: 'events_total',
          scan_config_id: 'scan-1',
          event_id: null,
          event_type_id: null,
          interval: '1h',
          latest_signal: null,
          sigma_threshold: 6,
          data: [
            {
              bucket: '2026-01-01T00:00:00Z',
              count: 10,
              expected_count: null,
              stddev: null,
              is_anomaly: false,
              anomaly_direction: null,
              z_score: null,
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    throw new Error(`Unhandled fetch: ${url}`)
  })
}

function renderCard(branchId: string | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TabMetricsCard
          slug="demo"
          activeEt={null}
          activeTabLabel="All events"
          activeTabSignal={null}
          isOpen
          onOpenChange={() => {}}
          branchId={branchId}
          filters={{
            filterEtId: undefined,
            debouncedSearch: '',
            queryStatuses: ['implemented'],
            filterTag: 'checkout',
          }}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TabMetricsCard', () => {
  it('hands the chart the sigma threshold the payload serves (tripl-2yww)', async () => {
    installFetch()
    renderCard(null)

    // 6, not undefined: dropping `sigmaThreshold={tabMetrics?.sigma_threshold}`
    // sends the band back to the chart's own default of 4.
    const chart = await screen.findByTestId('metrics-chart')
    expect(chart).toHaveAttribute('data-sigma-threshold', '6')
  })

  it('sends the active branch so the tag and status filter reads its events (tripl-vk1p)', async () => {
    const fetchSpy = installFetch()
    renderCard('branch-1')

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const url = new URL(String(fetchSpy.mock.calls[0][0]), 'http://localhost')
    expect(url.pathname).toContain('/api/v1/projects/demo/events-metrics')
    expect(url.searchParams.get('branch')).toBe('branch-1')
    expect(url.searchParams.get('tag')).toBe('checkout')
    expect(url.searchParams.getAll('status')).toEqual(['implemented'])
  })

  it('names no branch on main', async () => {
    const fetchSpy = installFetch()
    renderCard(null)

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const url = new URL(String(fetchSpy.mock.calls[0][0]), 'http://localhost')
    expect(url.searchParams.has('branch')).toBe(false)
  })
})
