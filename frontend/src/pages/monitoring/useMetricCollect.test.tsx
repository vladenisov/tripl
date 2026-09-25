import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MetricCollectNowResponse, MetricDefinitionDetailResponse } from '@/types'

vi.mock('@/api/metricsCatalog', () => ({
  metricsCatalogApi: { get: vi.fn(), collect: vi.fn() },
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { toast } from 'sonner'
import { metricsCatalogApi } from '@/api/metricsCatalog'
import { stopAllMetricCollectionWatches } from '@/hooks/useMetricCollectionWatcher'
import { metricDefinitionKey, metricsCatalogKey, monitoringSeriesKey } from '@/lib/queryKeys'
import { useMetricCollect, type CollectTarget } from './useMetricCollect'

const TARGET: CollectTarget = {
  slug: 'demo',
  scope: 'metric',
  scopeId: 'm-1',
  displayName: 'Checkout errors',
  isFactMetric: false,
}

// The watcher reads only the status fields; a partial payload keeps it focused.
function definitionWith(status: string | null, error: string | null = null) {
  return {
    id: 'm-1',
    last_collection_status: status,
    last_collection_error: error,
  } as unknown as MetricDefinitionDetailResponse
}

function Harness() {
  const collect = useMetricCollect('m-1')
  return (
    <button type="button" onClick={() => collect.start(TARGET)}>
      {collect.isCollecting ? 'Collecting' : 'Collect'}
    </button>
  )
}

function renderHarness(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/demo/monitoring/metric/m-1']}>
        <Routes>
          <Route path="/p/:slug/monitoring/:scope/:id" element={<Harness />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('useMetricCollect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(metricsCatalogApi.collect).mockResolvedValue({
      metric_count: 1,
    } as MetricCollectNowResponse)
  })

  afterEach(() => {
    // Unmount first: stopping a watch notifies every mounted reader.
    cleanup()
    stopAllMetricCollectionWatches()
  })

  it('finishes the watch and refreshes the metric after the page unmounts', async () => {
    let settleRun: (definition: MetricDefinitionDetailResponse) => void = () => {}
    vi.mocked(metricsCatalogApi.get).mockReturnValue(
      new Promise(resolve => {
        settleRun = resolve
      }),
    )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHarness(queryClient)

    fireEvent.click(screen.getByRole('button', { name: 'Collect' }))
    expect(await screen.findByRole('button', { name: 'Collecting' })).toBeInTheDocument()
    await waitFor(() => expect(metricsCatalogApi.get).toHaveBeenCalledWith('demo', 'm-1'))

    // The user leaves the page while the run is still going.
    unmount()
    await act(async () => {
      settleRun(definitionWith('error', 'warehouse timed out'))
    })

    expect(toast.error).toHaveBeenCalledWith('Collection failed: warehouse timed out')
    // A failed run still rewrites the definition's status and the catalog row.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: metricDefinitionKey('demo', 'm-1') })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: metricsCatalogKey('demo') })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: monitoringSeriesKey('demo', 'metric', 'm-1'),
    })
  })

  it('shows the run as in progress again when the page is reopened mid-run', async () => {
    vi.mocked(metricsCatalogApi.get).mockReturnValue(new Promise(() => {}))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const first = renderHarness(queryClient)

    fireEvent.click(screen.getByRole('button', { name: 'Collect' }))
    expect(await screen.findByRole('button', { name: 'Collecting' })).toBeInTheDocument()
    first.unmount()

    renderHarness(queryClient)
    expect(screen.getByRole('button', { name: 'Collecting' })).toBeInTheDocument()
  })
})
