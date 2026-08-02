import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkerHealthBanner } from './WorkerHealthBanner'
import type { WorkerHealth, WorkerHealthState } from '@/types'

const workerHealth = vi.fn()
vi.mock('@/api/system', () => ({ systemApi: { workerHealth: () => workerHealth() } }))

function renderWith(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

function renderBanner(health: Partial<WorkerHealth> & { state: WorkerHealthState }) {
  workerHealth.mockResolvedValue({
    last_heartbeat_at: null,
    stale_after_seconds: 180,
    ...health,
  })
  return renderWith(<WorkerHealthBanner />)
}

beforeEach(() => {
  workerHealth.mockReset()
})

describe('WorkerHealthBanner', () => {
  // The silent states matter most: a banner that fires on a healthy instance
  // gets learned-away, and then the real outage goes unread too.
  it.each<WorkerHealthState>(['ok', 'unknown'])('stays silent when state is %s', async state => {
    const { container } = renderBanner({ state })
    await waitFor(() => expect(workerHealth).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('stays silent while the probe is still in flight', () => {
    workerHealth.mockReturnValue(new Promise(() => {}))
    const { container } = renderWith(<WorkerHealthBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('stays silent when the probe itself fails', async () => {
    workerHealth.mockRejectedValue(new Error('network down'))
    const { container } = renderWith(<WorkerHealthBanner />)
    // A failed probe says nothing about the worker — it must not read as dead.
    await waitFor(() => expect(workerHealth).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('warns with the last-seen time when the pipeline went stale', async () => {
    renderBanner({
      state: 'stale',
      last_heartbeat_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    })
    expect(await screen.findByText('Background jobs are not running')).toBeInTheDocument()
    expect(screen.getByText(/last seen/)).toBeInTheDocument()
    expect(screen.getByText(/stalled/)).toBeInTheDocument()
    expect(screen.getByText(/docker compose up -d celery-worker celery-beat/)).toBeInTheDocument()
  })

  it('warns with distinct copy when the pipeline never started', async () => {
    renderBanner({ state: 'never' })
    expect(await screen.findByText('Background jobs are not running')).toBeInTheDocument()
    expect(screen.getByText('never started')).toBeInTheDocument()
    expect(screen.getByText(/has ever run on this instance/)).toBeInTheDocument()
    expect(screen.getByText(/docker compose up -d celery-worker celery-beat/)).toBeInTheDocument()
  })
})
