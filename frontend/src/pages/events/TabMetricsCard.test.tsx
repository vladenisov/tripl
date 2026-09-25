import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TabMetricsCard } from './TabMetricsCard'
import { unappliedChartFilters } from './utils'

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

function renderCard(
  branchId: string | null,
  { isOpen = true, unappliedFilters }: { isOpen?: boolean; unappliedFilters?: string[] } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TabMetricsCard
          slug="demo"
          activeEt={null}
          activeTabLabel="All events"
          activeTabSignal={null}
          isOpen={isOpen}
          onOpenChange={() => {}}
          branchId={branchId}
          unappliedFilters={unappliedFilters}
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

  it('neither fetches nor polls while the chart is collapsed (EVT-20)', async () => {
    const fetchSpy = installFetch()
    renderCard(null, { isOpen: false })

    expect(await screen.findByRole('button', { name: /Show chart/ })).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('names the table filters its series does not apply (EVT-20)', async () => {
    installFetch()
    renderCard(null, { unappliedFilters: ['activity', 'column filters'] })

    expect(
      await screen.findByText(/Not narrowed by activity, column filters\./),
    ).toBeInTheDocument()
  })
})

describe('unappliedChartFilters', () => {
  it('lists only the active filters the metrics endpoint cannot take', () => {
    expect(
      unappliedChartFilters({
        filterSilentDays: undefined,
        filterReviewed: undefined,
        filterOpenQuestions: undefined,
        hasColumnFilters: false,
      }),
    ).toEqual([])
    expect(
      unappliedChartFilters({
        filterSilentDays: 7,
        filterReviewed: false,
        filterOpenQuestions: true,
        hasColumnFilters: true,
      }),
    ).toEqual(['activity', 'reviewed', 'questions', 'column filters'])
  })
})
