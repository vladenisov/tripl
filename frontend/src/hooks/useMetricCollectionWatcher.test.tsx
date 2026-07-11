import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MetricDefinitionResponse } from '@/types'

vi.mock('@/api/metricsCatalogApi', () => ({
  metricsCatalogApi: { get: vi.fn() },
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { toast } from 'sonner'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { useMetricCollectionWatcher } from './useMetricCollectionWatcher'

// The watcher only reads id / last_collection_status / last_collection_error;
// a minimal shape keeps the fixtures focused (mirrors MetricsPage.test.tsx's
// `as unknown as` casts for partial API payloads).
function definitionWith(
  status: string | null,
  error: string | null = null,
): MetricDefinitionResponse {
  return {
    id: 'm-1',
    last_collection_status: status,
    last_collection_error: error,
  } as unknown as MetricDefinitionResponse
}

function Harness({
  onSettled,
}: {
  onSettled?: (metricId: string, status: 'success' | 'error') => void
}) {
  const watcher = useMetricCollectionWatcher('demo', onSettled, { pollIntervalMs: 10 })
  return (
    <button type="button" onClick={() => watcher.watch('m-1', 'Checkout errors')}>
      {watcher.isWatching ? 'watching' : 'idle'}
    </button>
  )
}

function renderHarness(onSettled?: (metricId: string, status: 'success' | 'error') => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness onSettled={onSettled} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useMetricCollectionWatcher', () => {
  it('does not poll until a watch starts', () => {
    renderHarness()

    expect(screen.getByRole('button')).toHaveTextContent('idle')
    expect(metricsCatalogApi.get).not.toHaveBeenCalled()
  })

  it('toasts success and settles when the run reports success', async () => {
    vi.mocked(metricsCatalogApi.get).mockResolvedValue(definitionWith('success'))
    const onSettled = vi.fn()
    renderHarness(onSettled)

    fireEvent.click(screen.getByRole('button'))

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        '"Checkout errors" collected — the chart is up to date.',
      ),
    )
    expect(metricsCatalogApi.get).toHaveBeenCalledWith('demo', 'm-1')
    expect(onSettled).toHaveBeenCalledWith('m-1', 'success')
    // The watch stops once terminal.
    expect(screen.getByRole('button')).toHaveTextContent('idle')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('toasts the persisted failure reason when the run reports error', async () => {
    vi.mocked(metricsCatalogApi.get).mockResolvedValue(
      definitionWith('error', 'warehouse query timed out'),
    )
    const onSettled = vi.fn()
    renderHarness(onSettled)

    fireEvent.click(screen.getByRole('button'))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Collection failed: warehouse query timed out'),
    )
    expect(onSettled).toHaveBeenCalledWith('m-1', 'error')
    expect(screen.getByRole('button')).toHaveTextContent('idle')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('falls back to a generic failure message when no reason was persisted', async () => {
    vi.mocked(metricsCatalogApi.get).mockResolvedValue(definitionWith('error'))
    renderHarness()

    fireEvent.click(screen.getByRole('button'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Collection failed.'))
  })

  it('keeps polling while the run is still running, then settles', async () => {
    vi.mocked(metricsCatalogApi.get)
      .mockResolvedValueOnce(definitionWith('running'))
      .mockResolvedValueOnce(definitionWith('running'))
      .mockResolvedValue(definitionWith('success'))
    const onSettled = vi.fn()
    renderHarness(onSettled)

    fireEvent.click(screen.getByRole('button'))

    // Still watching after the first "running" response — no toast yet.
    await waitFor(() => expect(metricsCatalogApi.get).toHaveBeenCalled())
    expect(screen.getByRole('button')).toHaveTextContent('watching')
    expect(toast.success).not.toHaveBeenCalled()

    // The 10ms poll interval re-fetches until the terminal status lands.
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(vi.mocked(metricsCatalogApi.get).mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(onSettled).toHaveBeenCalledWith('m-1', 'success')
  })
})
