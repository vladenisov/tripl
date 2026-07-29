import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MonitoringTab } from './MonitoringTab'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function settingsPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'settings-1',
    project_id: 'proj-1',
    anomaly_detection_enabled: true,
    detect_project_total: true,
    detect_event_types: true,
    detect_events: true,
    detect_metrics: true,
    baseline_window_buckets: 168,
    min_history_buckets: 24,
    sigma_threshold: 3,
    min_expected_count: 100,
    recent_signal_window_hours: 24,
    anomaly_ingestion_settling_minutes: 120,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

function mockSettingsFetch(overrides: Record<string, unknown> = {}) {
  const patches: unknown[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.includes('/anomaly-settings')) {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body))
        patches.push(body)
        return jsonResponse(settingsPayload({ ...overrides, ...body }))
      }
      return jsonResponse(settingsPayload(overrides))
    }
    throw new Error(`Unhandled fetch: ${url}`)
  })
  return patches
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MonitoringTab slug="demo" />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MonitoringTab — catalog metric detection (tripl-jfm3.108)', () => {
  it('exposes the metric scope alongside the other three', async () => {
    // detect_metrics has always defaulted to on with no control anywhere, so the
    // only way to stop scoring catalog metrics was to disable detection wholesale.
    mockSettingsFetch()
    renderTab()

    const metrics = await screen.findByLabelText('Metrics')
    expect(metrics).toBeChecked()
  })

  it('reflects a disabled metric scope from the server', async () => {
    mockSettingsFetch({ detect_metrics: false })
    renderTab()

    expect(await screen.findByLabelText('Metrics')).not.toBeChecked()
    // The neighbouring scopes stay independent.
    expect(screen.getByLabelText('Events')).toBeChecked()
  })

  it('patches detect_metrics when toggled off', async () => {
    const patches = mockSettingsFetch()
    renderTab()

    fireEvent.click(await screen.findByLabelText('Metrics'))

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({ detect_metrics: false })
  })
})
