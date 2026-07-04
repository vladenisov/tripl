import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MonitorsPage from './MonitorsPage'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockSummary(body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('/monitors-summary')) return jsonResponse(body)
    throw new Error(`Unhandled fetch: ${url}`)
  })
}

function renderMonitors() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/demo/monitors']}>
        <Routes>
          <Route path="/p/:slug/monitors" element={<MonitorsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MonitorsPage', () => {
  it('shows the rollup and a firing monitor row', async () => {
    mockSummary({
      monitors: [
        {
          rule_id: 'rule-1',
          rule_name: 'payment_failed spike',
          destination_id: 'dest-1',
          destination_name: 'Main Slack',
          destination_type: 'slack',
          enabled: true,
          status: 'firing',
          active_scope_count: 2,
          firing_scope_count: 1,
          last_anomaly_at: '2026-06-13T10:00:00Z',
          last_notified_at: null,
          notify_on_spike: true,
          notify_on_drop: false,
          min_percent_delta: 50,
          min_expected_count: 100,
          cooldown_minutes: 60,
        },
      ],
      firing_count: 1,
      warning_count: 0,
      healthy_count: 0,
      total: 1,
    })

    renderMonitors()

    expect(await screen.findByRole('heading', { name: 'Monitors' })).toBeInTheDocument()
    expect(await screen.findByText('payment_failed spike')).toBeInTheDocument()
    // "Firing" appears both as the rollup KPI label and the row status chip.
    expect(screen.getAllByText('Firing').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Healthy')).toBeInTheDocument()
    expect(screen.getByText('slack')).toBeInTheDocument()
  })

  it('explains the destination name with a tooltip (L7)', async () => {
    mockSummary({
      monitors: [
        {
          rule_id: 'rule-1',
          rule_name: 'payment_failed spike',
          destination_id: 'dest-1',
          destination_name: 'Dev',
          destination_type: 'telegram',
          enabled: true,
          status: 'firing',
          active_scope_count: 1,
          firing_scope_count: 1,
          last_anomaly_at: null,
          last_notified_at: null,
          notify_on_spike: true,
          notify_on_drop: false,
          min_percent_delta: 0,
          min_expected_count: 0,
          cooldown_minutes: 30,
        },
      ],
      firing_count: 1,
      warning_count: 0,
      healthy_count: 0,
      total: 1,
    })

    renderMonitors()

    const destination = await screen.findByText('Dev')
    expect(destination).toHaveAttribute(
      'title',
      'Routes to the "Dev" telegram destination',
    )
  })

  it('makes each monitor row drill into its detail route (H8/UX-12)', async () => {
    mockSummary({
      monitors: [
        {
          rule_id: 'rule-1',
          rule_name: 'payment_failed spike',
          destination_id: 'dest-1',
          destination_name: 'Main Slack',
          destination_type: 'slack',
          enabled: true,
          status: 'firing',
          active_scope_count: 1,
          firing_scope_count: 1,
          last_anomaly_at: null,
          last_notified_at: null,
          notify_on_spike: true,
          notify_on_drop: false,
          min_percent_delta: 0,
          min_expected_count: 0,
          cooldown_minutes: 30,
          muted: false,
          muted_until: null,
        },
      ],
      firing_count: 1,
      warning_count: 0,
      healthy_count: 0,
      total: 1,
    })

    renderMonitors()

    const row = (await screen.findByText('payment_failed spike')).closest('[role="row"]')
    expect(row).not.toBeNull()
    // The row is now a real drill-in target, so it must read as interactive.
    expect(row).toHaveClass('cursor-pointer')
    // A real, keyboard-focusable link carries the navigation.
    const link = screen.getByRole('link', { name: 'payment_failed spike' })
    expect(link).toHaveAttribute('href', '/p/demo/monitors/rule-1')
  })

  it('flags a muted monitor row', async () => {
    mockSummary({
      monitors: [
        {
          rule_id: 'rule-1',
          rule_name: 'payment_failed spike',
          destination_id: 'dest-1',
          destination_name: 'Main Slack',
          destination_type: 'slack',
          enabled: true,
          status: 'healthy',
          active_scope_count: 0,
          firing_scope_count: 0,
          last_anomaly_at: null,
          last_notified_at: null,
          notify_on_spike: true,
          notify_on_drop: false,
          min_percent_delta: 0,
          min_expected_count: 0,
          cooldown_minutes: 30,
          muted: true,
          muted_until: '2099-01-01T00:00:00Z',
        },
      ],
      firing_count: 0,
      warning_count: 0,
      healthy_count: 1,
      total: 1,
    })

    renderMonitors()

    await screen.findByText('payment_failed spike')
    expect(screen.getByText('muted')).toBeInTheDocument()
  })

  it('shows an empty state with a link to alerting settings', async () => {
    mockSummary({
      monitors: [],
      firing_count: 0,
      warning_count: 0,
      healthy_count: 0,
      total: 0,
    })

    renderMonitors()

    expect(await screen.findByText(/No monitors yet/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Alerting settings/ })).toHaveAttribute(
      'href',
      '/p/demo/settings/alerting',
    )

    // The all-zero FIRING / WARNING / HEALTHY / MONITORS stat row must not
    // render above the empty state (tripl-7l83.14).
    expect(screen.queryByText('Firing')).toBeNull()
    expect(screen.queryByText('Warning')).toBeNull()
    expect(screen.queryByText('Healthy')).toBeNull()
  })
})
