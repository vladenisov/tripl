import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { projectsApi } from '@/api/projects'
import type { Project } from '@/types'
import { useDemoProvisioning } from './useDemoProvisioning'

function makeProject(slug = 'demo-1'): Project {
  return {
    id: 'p-1',
    name: 'Demo workspace',
    slug,
    description: '',
    app_version_keep_releases: 5,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    is_demo: true,
    generation_status: 'ready',
    summary: {
      event_type_count: 0,
      event_count: 0,
      active_event_count: 0,
      implemented_event_count: 0,
      review_pending_event_count: 0,
      archived_event_count: 0,
      variable_count: 0,
      scan_count: 0,
      alert_destination_count: 0,
      alert_rule_count: 0,
      monitoring_signal_count: 0,
      firing_monitor_count: 0,
      open_incident_count: 0,
      failing_scan_config_count: 0,
      latest_scan_job: null,
      latest_signal: null,
    },
  }
}

function Harness({ timeoutMs }: { timeoutMs?: number }) {
  const provisioning = useDemoProvisioning({ timeoutMs })
  const location = useLocation()
  return (
    <div>
      <span data-testid="status">{provisioning.status}</span>
      <span data-testid="path">{location.pathname}</span>
      <span data-testid="timed-out">{String(provisioning.timedOut)}</span>
      <span data-testid="cancel-outcome">{provisioning.cancelOutcome ?? 'none'}</span>
      {provisioning.error ? (
        <span data-testid="error">{(provisioning.error as Error).message}</span>
      ) : null}
      <button type="button" onClick={() => provisioning.start()}>
        start
      </button>
      <button type="button" onClick={() => provisioning.retry()}>
        retry
      </button>
      <button type="button" onClick={() => provisioning.cancel()}>
        cancel
      </button>
    </div>
  )
}

function renderHarness(timeoutMs?: number) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/workspace']}>
        <Harness timeoutMs={timeoutMs} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

/** A create that only ever settles when its AbortSignal fires. */
function stallUntilAborted() {
  const captured: { signal?: AbortSignal } = {}
  vi.spyOn(projectsApi, 'createDemo').mockImplementation(
    (signal?: AbortSignal) =>
      new Promise<Project>((_resolve, reject) => {
        captured.signal = signal
        signal?.addEventListener('abort', () => {
          reject(new ApiError('Request to the backend timed out.', 408))
        })
      }),
  )
  return captured
}

describe('useDemoProvisioning — a stalled create is escapable (tripl-2su6.15)', () => {
  it('cancel aborts the request AND asks the server to abandon it (tripl-jfm3.12)', async () => {
    const captured = stallUntilAborted()
    const cancelSpy = vi
      .spyOn(projectsApi, 'cancelDemo')
      .mockResolvedValue({ cancelled: true, slug: 'demo-abc123' })

    renderHarness()
    fireEvent.click(screen.getByText('start'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('provisioning'))
    expect(captured.signal?.aborted).toBe(false)

    fireEvent.click(screen.getByText('cancel'))

    // The request is actually aborted (not just ignored)…
    await waitFor(() => expect(captured.signal?.aborted).toBe(true))
    // …but aborting the fetch alone left the server seeding happily on, so the
    // cancel is also sent to the backend, which deletes the shell.
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    // A user-initiated cancel is never an error state.
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('cancelled'))
    expect(screen.getByTestId('cancel-outcome')).toHaveTextContent('stopped')
    expect(screen.queryByTestId('error')).not.toBeInTheDocument()
  })

  it('reports honestly when the create was already past the point of no return', async () => {
    stallUntilAborted()
    vi.spyOn(projectsApi, 'cancelDemo').mockResolvedValue({ cancelled: false, slug: null })

    renderHarness()
    fireEvent.click(screen.getByText('start'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('provisioning'))
    fireEvent.click(screen.getByText('cancel'))

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('cancelled'))
    expect(screen.getByTestId('cancel-outcome')).toHaveTextContent('already-finished')
  })

  it('never claims a stop when the cancel call itself fails', async () => {
    stallUntilAborted()
    vi.spyOn(projectsApi, 'cancelDemo').mockRejectedValue(new ApiError('offline', 503))

    renderHarness()
    fireEvent.click(screen.getByText('start'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('provisioning'))
    fireEvent.click(screen.getByText('cancel'))

    await waitFor(() => expect(screen.getByTestId('cancel-outcome')).toHaveTextContent('already-finished'))
  })

  it('aborts a create that hangs past the timeout', async () => {
    const captured = stallUntilAborted()

    // A short real timeout rather than a fake clock: react-query batches its
    // state notifications behind a timer of its own, and freezing that clock
    // deadlocks waitFor.
    renderHarness(20)
    fireEvent.click(screen.getByText('start'))

    // Without a bound this request would hang forever, and the dialog with it.
    await waitFor(() => expect(captured.signal?.aborted).toBe(true))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'))
    // Reported as a timeout, so the dialog can avoid claiming a rollback.
    expect(screen.getByTestId('timed-out')).toHaveTextContent('true')
  })
})

describe('useDemoProvisioning', () => {
  it('enters the provisioning (pending) state while the create is in flight', async () => {
    // A create that never resolves keeps the flow in-flight.
    vi.spyOn(projectsApi, 'createDemo').mockReturnValue(new Promise<Project>(() => {}))

    renderHarness()
    fireEvent.click(screen.getByText('start'))

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('provisioning')
    })
  })

  it('guards against duplicate creates on a double-click', async () => {
    const spy = vi
      .spyOn(projectsApi, 'createDemo')
      .mockReturnValue(new Promise<Project>(() => {}))

    renderHarness()
    const start = screen.getByText('start')
    // Two synchronous clicks — the in-flight ref guard blocks the second before
    // any state update lands.
    fireEvent.click(start)
    fireEvent.click(start)

    // Exactly one demo is ever dispatched, even on a rapid double-click.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    // Give any second dispatch a chance to (not) happen.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('routes to the new demo Overview welcome on success (not Events)', async () => {
    vi.spyOn(projectsApi, 'createDemo').mockResolvedValue(makeProject('demo-42'))

    renderHarness()
    fireEvent.click(screen.getByText('start'))

    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/p/demo-42/overview')
    })
    expect(screen.getByTestId('status')).toHaveTextContent('success')
  })

  it('surfaces a 500 as an error state without navigating away', async () => {
    vi.spyOn(projectsApi, 'createDemo').mockRejectedValue(
      new ApiError('Demo provisioning failed and was rolled back.', 500),
    )

    renderHarness()
    fireEvent.click(screen.getByText('start'))

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('error')
    })
    expect(screen.getByTestId('error')).toHaveTextContent('rolled back')
    // Stayed on the workspace — a failed demo never routes into a half-built project.
    expect(screen.getByTestId('path')).toHaveTextContent('/workspace')
  })

  it('never rejects the mutation, so the app-wide error toast stays silent (tripl-jfm3.13)', async () => {
    // main.tsx registers `new MutationCache({ onError: surfaceError })`, which
    // toasted every rejected mutation — turning a deliberate cancel into a red
    // "the backend timed out" toast and double-reporting a genuine 500.
    const onError = vi.fn()
    const queryClient = new QueryClient({
      mutationCache: new MutationCache({ onError }),
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    vi.spyOn(projectsApi, 'cancelDemo').mockResolvedValue({ cancelled: true, slug: 'demo-x' })
    const captured = stallUntilAborted()

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/workspace']}>
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByText('start'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('provisioning'))
    fireEvent.click(screen.getByText('cancel'))
    await waitFor(() => expect(captured.signal?.aborted).toBe(true))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('cancelled'))

    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a 500 in the hook without rejecting the mutation (tripl-jfm3.13)', async () => {
    const onError = vi.fn()
    const queryClient = new QueryClient({
      mutationCache: new MutationCache({ onError }),
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    vi.spyOn(projectsApi, 'createDemo').mockRejectedValue(new ApiError('boom', 500))

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/workspace']}>
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByText('start'))

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'))
    // The dialog renders it once; the global toast never sees it.
    expect(screen.getByTestId('error')).toHaveTextContent('boom')
    expect(onError).not.toHaveBeenCalled()
  })

  it('retry runs a fresh create after a failure', async () => {
    const spy = vi
      .spyOn(projectsApi, 'createDemo')
      .mockRejectedValueOnce(new ApiError('boom', 500))
      .mockResolvedValueOnce(makeProject('demo-retry'))

    renderHarness()
    fireEvent.click(screen.getByText('start'))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'))

    fireEvent.click(screen.getByText('retry'))
    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/p/demo-retry/overview')
    })
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
