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
  const watcher = useMetricCollectionWatcher(onSettled, { pollIntervalMs: 10 })
  return (
    <button
      type="button"
      onClick={() =>
        watcher.watch({ slug: 'demo', metricId: 'm-1', displayName: 'Checkout errors' })
      }
    >
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

// Mirrors MonitoringDetailPage: the spinner is keyed to the *watched* metric
// (not a raw `isWatching`), and the watch captures the current route's ids at
// collect-start so a completion can invalidate the metric it actually collected
// — even after an `:id`-only navigation that does NOT remount the page
// (tripl-0s3d).
type NavRoute = { slug: string; scope: string; scopeId: string }

function NavHarness({
  route,
  onInvalidate,
}: {
  route: NavRoute
  onInvalidate: (slug: string, scope: string, scopeId: string) => void
}) {
  const watcher = useMetricCollectionWatcher<NavRoute>(
    (_metricId, status, context) => {
      if (status !== 'success' || !context) return
      onInvalidate(context.slug, context.scope, context.scopeId)
    },
    { pollIntervalMs: 10 },
  )
  const isCollecting = watcher.watchingMetricId === route.scopeId
  return (
    <button
      type="button"
      onClick={() =>
        watcher.watch({
          slug: route.slug,
          metricId: route.scopeId,
          displayName: `Metric ${route.scopeId}`,
          context: route,
        })
      }
    >
      {isCollecting ? 'collecting' : 'idle'}
    </button>
  )
}

function renderNavHarness(
  route: NavRoute,
  onInvalidate: (slug: string, scope: string, scopeId: string) => void,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const ui = (nextRoute: NavRoute) => (
    <QueryClientProvider client={queryClient}>
      <NavHarness route={nextRoute} onInvalidate={onInvalidate} />
    </QueryClientProvider>
  )
  const view = render(ui(route))
  // Simulates navigating to another metric (or project) without unmounting.
  const navigateTo = (nextRoute: NavRoute) => view.rerender(ui(nextRoute))
  return { ...view, navigateTo }
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
    // No context captured by this harness, so the third arg is undefined.
    expect(onSettled).toHaveBeenCalledWith('m-1', 'success', undefined)
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
    expect(onSettled).toHaveBeenCalledWith('m-1', 'error', undefined)
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
    expect(onSettled).toHaveBeenCalledWith('m-1', 'success', undefined)
  })

  it('does not show a metric navigated to mid-watch as collecting (tripl-0s3d)', async () => {
    // The watch stays in flight (never leaves "running") across the navigation.
    vi.mocked(metricsCatalogApi.get).mockResolvedValue(definitionWith('running'))
    const onInvalidate = vi.fn()
    const { navigateTo } = renderNavHarness(
      { slug: 'demo', scope: 'metric', scopeId: 'A' },
      onInvalidate,
    )

    // Start collecting metric A.
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(metricsCatalogApi.get).toHaveBeenCalledWith('demo', 'A'))
    expect(screen.getByRole('button')).toHaveTextContent('collecting')

    // Navigate to metric B while A is still collecting — same page, no remount.
    navigateTo({ slug: 'demo', scope: 'metric', scopeId: 'B' })

    // B must NOT inherit A's in-flight watch state.
    expect(screen.getByRole('button')).toHaveTextContent('idle')
  })

  it("invalidates the metric captured at collect-start, not the one navigated to (tripl-0s3d)", async () => {
    vi.mocked(metricsCatalogApi.get).mockResolvedValue(definitionWith('running'))
    const onInvalidate = vi.fn()
    const { navigateTo } = renderNavHarness(
      { slug: 'demo', scope: 'metric', scopeId: 'A' },
      onInvalidate,
    )

    // Start collecting metric A (captures { scope: 'metric', scopeId: 'A' }).
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(metricsCatalogApi.get).toHaveBeenCalledWith('demo', 'A'))

    // Navigate to metric B while A's collection is still running.
    navigateTo({ slug: 'demo', scope: 'metric', scopeId: 'B' })

    // A's run now settles successfully.
    vi.mocked(metricsCatalogApi.get).mockResolvedValue(definitionWith('success'))

    await waitFor(() => expect(onInvalidate).toHaveBeenCalled())
    // Completion invalidates A's captured scope — never the navigated-to B.
    expect(onInvalidate).toHaveBeenCalledWith('demo', 'metric', 'A')
    expect(onInvalidate).not.toHaveBeenCalledWith('demo', 'metric', 'B')
  })

  it('keeps polling the originating project after a cross-project move (tripl-htvg)', async () => {
    vi.mocked(metricsCatalogApi.get).mockResolvedValue(definitionWith('running'))
    const onInvalidate = vi.fn()
    const { navigateTo } = renderNavHarness(
      { slug: 'project-a', scope: 'metric', scopeId: 'A' },
      onInvalidate,
    )

    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(metricsCatalogApi.get).toHaveBeenCalledWith('project-a', 'A'))

    // Leave for another project entirely while A is still collecting. The poll
    // used to read the slug live, so it started asking project-b for metric A —
    // an id that does not exist there.
    navigateTo({ slug: 'project-b', scope: 'metric', scopeId: 'B' })
    vi.mocked(metricsCatalogApi.get).mockResolvedValue(definitionWith('success'))

    await waitFor(() => expect(onInvalidate).toHaveBeenCalled())
    expect(metricsCatalogApi.get).not.toHaveBeenCalledWith('project-b', 'A')
    // The settle invalidates the project the collect was fired against.
    expect(onInvalidate).toHaveBeenCalledWith('project-a', 'metric', 'A')
  })
})
