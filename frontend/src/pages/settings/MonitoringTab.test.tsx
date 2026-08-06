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

function scopeOverridePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'override-1',
    scan_config_id: 'scan-1',
    scan_config_name: 'Events',
    scope_type: 'event',
    scope_ref: 'event-1',
    scope_name: 'checkout_started',
    sigma_threshold: 4.5,
    min_expected_count: 55,
    false_positive_count: 1,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

function mockSettingsFetch(
  overrides: Record<string, unknown> = {},
  scopeOverrides: Record<string, unknown>[] = [],
) {
  const patches: unknown[] = []
  const deletes: string[] = []
  let remaining = scopeOverrides
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.includes('/anomaly-settings/scope-overrides')) {
      if (init?.method === 'DELETE') {
        const id = url.split('/').pop() ?? ''
        deletes.push(id)
        remaining = remaining.filter(item => item.id !== id)
        return new Response(null, { status: 204 })
      }
      return jsonResponse({ items: remaining, total: remaining.length })
    }
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
  return { patches, deletes }
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
    const { patches } = mockSettingsFetch()
    renderTab()

    fireEvent.click(await screen.findByLabelText('Metrics'))

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toEqual({ detect_metrics: false })
  })
})

describe('MonitoringTab — settling allowance vs open signal window (tripl-l429.15)', () => {
  // A settling allowance that reaches the open signal window blanks the
  // Anomalies page, the sidebar badge and the Overview stat while alerts keep
  // firing, so the backend refuses the pair. These bounds are how an operator
  // sees the constraint before hitting the 422.
  it('caps the settling field one minute under the stored window', async () => {
    mockSettingsFetch({ recent_signal_window_hours: 24 })
    renderTab()

    const settling = await screen.findByLabelText('Ingestion settling (minutes)')
    expect(settling).toHaveAttribute('max', '1439')
  })

  it('never lets the settling cap exceed the absolute 1440 limit', async () => {
    // A 30-day window would otherwise imply a 43199-minute ceiling.
    mockSettingsFetch({ recent_signal_window_hours: 720 })
    renderTab()

    const settling = await screen.findByLabelText('Ingestion settling (minutes)')
    expect(settling).toHaveAttribute('max', '1440')
  })

  it('floors the window field just above the stored allowance', async () => {
    // 120 minutes of settling needs a window of 3h: 2h is exactly 120 and the
    // two must not be equal.
    mockSettingsFetch({ anomaly_ingestion_settling_minutes: 120 })
    renderTab()

    const window = await screen.findByLabelText('Open signal window (hours)')
    expect(window).toHaveAttribute('min', '3')
  })

  it('names the paired setting in both hints', async () => {
    mockSettingsFetch({ recent_signal_window_hours: 24, anomaly_ingestion_settling_minutes: 120 })
    renderTab()

    expect(
      await screen.findByText(/the ceiling is one minute under the open signal window/i),
    ).toBeInTheDocument()
    expect(screen.getByText(/would close every signal before it could be scored/i)).toBeInTheDocument()
  })

  it('surfaces the backend refusal instead of failing silently', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/anomaly-settings/scope-overrides')) {
        return jsonResponse({ items: [], total: 0 })
      }
      if (url.includes('/anomaly-settings')) {
        if (init?.method === 'PATCH') {
          return new Response(
            JSON.stringify({
              detail:
                'Ingestion settling (1440 min) must stay below the open signal window ' +
                '(24h = 1440 min).',
            }),
            { status: 422, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return jsonResponse(settingsPayload())
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })
    renderTab()

    const settling = await screen.findByLabelText('Ingestion settling (minutes)')
    fireEvent.change(settling, { target: { value: '1440' } })
    fireEvent.blur(settling)

    expect(
      await screen.findByText(/must stay below the open signal window/i),
    ).toBeInTheDocument()
  })
})

describe('MonitoringTab — false-positive scope overrides', () => {
  it('says nothing is tightened when no scope has been ratcheted', async () => {
    mockSettingsFetch()
    renderTab()

    expect(
      await screen.findByText(/No scope has been tightened/i),
    ).toBeInTheDocument()
  })

  it('names the tightened scope and the values that replaced the project settings', async () => {
    mockSettingsFetch({}, [scopeOverridePayload()])
    renderTab()

    expect(await screen.findByText('checkout_started')).toBeInTheDocument()
    expect(screen.getByText(/Event · Events · sigma 4\.5 · min expected 55/)).toBeInTheDocument()
  })

  it('removes an override so the scope falls back to the project settings', async () => {
    // The ratchet is permanent and never decays, so this button is the ONLY way
    // back for a scope an operator tightened by mistake.
    const { deletes } = mockSettingsFetch({}, [scopeOverridePayload()])
    renderTab()

    fireEvent.click(await screen.findByLabelText('Remove override for checkout_started'))

    await waitFor(() => expect(deletes).toEqual(['override-1']))
    await waitFor(() =>
      expect(screen.getByText(/No scope has been tightened/i)).toBeInTheDocument(),
    )
  })
})
