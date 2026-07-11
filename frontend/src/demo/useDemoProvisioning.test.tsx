import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
      monitoring_signal_count: 0,
      firing_monitor_count: 0,
      failing_scan_config_count: 0,
      latest_scan_job: null,
      latest_signal: null,
    },
  }
}

function Harness() {
  const provisioning = useDemoProvisioning()
  const location = useLocation()
  return (
    <div>
      <span data-testid="status">{provisioning.status}</span>
      <span data-testid="path">{location.pathname}</span>
      {provisioning.error ? (
        <span data-testid="error">{(provisioning.error as Error).message}</span>
      ) : null}
      <button type="button" onClick={() => provisioning.start()}>
        start
      </button>
      <button type="button" onClick={() => provisioning.retry()}>
        retry
      </button>
    </div>
  )
}

function renderHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/workspace']}>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
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
