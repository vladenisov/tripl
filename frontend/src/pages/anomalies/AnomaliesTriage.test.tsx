import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MonitoringSignal, SignalTriageState } from '@/types'
import AnomaliesPage from '../AnomaliesPage'

vi.mock('@/api/eventMetrics', () => ({
  eventMetricsApi: {
    getActiveSignals: vi.fn(),
    getSignalSeries: vi.fn(),
    acknowledgeSignal: vi.fn(),
    unacknowledgeSignal: vi.fn(),
    muteSignalScope: vi.fn(),
    unmuteSignalScope: vi.fn(),
    markSignalExpected: vi.fn(),
    unmarkSignalExpected: vi.fn(),
  },
}))
vi.mock('@/api/scans', () => ({
  scansApi: { list: vi.fn() },
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { toast } from 'sonner'
import { eventMetricsApi } from '@/api/eventMetrics'
import { scansApi } from '@/api/scans'

const STATE: SignalTriageState = {
  acknowledged_at: null,
  muted: false,
  muted_until: null,
  expected: false,
  expected_note: null,
  hidden: false,
}

function makeSignal(overrides: Partial<MonitoringSignal>): MonitoringSignal {
  return {
    scan_config_id: 'scan-1',
    scope_type: 'event_type',
    scope_ref: 'et-1',
    state: 'latest_scan',
    event_id: null,
    event_type_id: 'et-1',
    bucket: '2026-09-25T18:00:00Z',
    actual_count: 120,
    expected_count: 40,
    stddev: 5,
    z_score: 8,
    direction: 'spike',
    scope_name: 'Signup',
    incident_child: false,
    unit: null,
    detected_at: null,
    ...overrides,
  }
}

function LocationProbe() {
  const location = useLocation()
  return <div>anomalies-location:{location.search}</div>
}

function renderAnomalies(entry = '/p/demo/anomalies') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <LocationProbe />
        <Routes>
          <Route path="/p/:slug/anomalies" element={<AnomaliesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function rowOf(name: string): HTMLElement {
  const [label] = screen.getAllByText((_content, element) =>
    !!element?.hasAttribute('data-anomaly-label') && (element.textContent ?? '').endsWith(name),
  )
  if (!label) throw new Error(`No anomaly row labelled ${name}`)
  return label.closest('[role="row"]') as HTMLElement
}

async function openMenu(name: string): Promise<void> {
  await screen.findAllByText((_content, element) =>
    !!element?.hasAttribute('data-anomaly-label') && (element.textContent ?? '').endsWith(name),
  )
  fireEvent.keyDown(within(rowOf(name)).getByRole('button', { name: 'Signal actions' }), {
    key: 'Enter',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(scansApi.list).mockResolvedValue([])
  vi.mocked(eventMetricsApi.getSignalSeries).mockResolvedValue([])
  vi.mocked(eventMetricsApi.acknowledgeSignal).mockResolvedValue({
    ...STATE,
    acknowledged_at: '2026-09-25T19:00:00Z',
  })
  vi.mocked(eventMetricsApi.muteSignalScope).mockResolvedValue({ ...STATE, muted: true, hidden: true })
  vi.mocked(eventMetricsApi.markSignalExpected).mockResolvedValue({
    ...STATE,
    expected: true,
    hidden: true,
  })
  vi.mocked(eventMetricsApi.unmuteSignalScope).mockResolvedValue(undefined)
})

describe('AnomaliesPage — triage (MO-4 / JR-5)', () => {
  it('offers acknowledge, mark as expected and the three mute lengths on an unrouted signal', async () => {
    vi.mocked(eventMetricsApi.getActiveSignals).mockResolvedValue([makeSignal({})])
    renderAnomalies()
    await openMenu('Signup')

    expect(await screen.findByRole('menuitem', { name: 'Acknowledge' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Mark as expected…' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Mute for 24 hours' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Mute for 7 days' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Mute until unmuted' })).toBeInTheDocument()
  })

  it('keeps triage in the inbox for a signal routed to an incident', async () => {
    vi.mocked(eventMetricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ incident_id: 'group-1', incident_status: 'open' }),
    ])
    renderAnomalies()
    await openMenu('Signup')

    expect(await screen.findByRole('menuitem', { name: 'Open incident' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Acknowledge' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /^Mute / })).not.toBeInTheDocument()
  })

  it('acknowledges with the signal key and confirms with an Undo', async () => {
    vi.mocked(eventMetricsApi.getActiveSignals).mockResolvedValue([makeSignal({})])
    renderAnomalies()
    await openMenu('Signup')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Acknowledge' }))

    await waitFor(() =>
      expect(eventMetricsApi.acknowledgeSignal).toHaveBeenCalledWith('demo', {
        scan_config_id: 'scan-1',
        scope_type: 'event_type',
        scope_ref: 'et-1',
        bucket: '2026-09-25T18:00:00Z',
      }),
    )
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Signal acknowledged',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
      ),
    )
  })

  it('mutes the scope for the chosen length', async () => {
    vi.mocked(eventMetricsApi.getActiveSignals).mockResolvedValue([makeSignal({})])
    renderAnomalies()
    await openMenu('Signup')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mute for 7 days' }))

    await waitFor(() =>
      expect(eventMetricsApi.muteSignalScope).toHaveBeenCalledWith(
        'demo',
        expect.objectContaining({ scope_ref: 'et-1' }),
        '7d',
      ),
    )
  })

  it('marks as expected with the note typed in the dialog', async () => {
    vi.mocked(eventMetricsApi.getActiveSignals).mockResolvedValue([makeSignal({})])
    renderAnomalies()
    await openMenu('Signup')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark as expected…' }))

    const dialog = await screen.findByRole('dialog', { name: 'Mark as expected' })
    fireEvent.change(within(dialog).getByLabelText(/Why was it expected/), {
      target: { value: '  Campaign launch ' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as expected' }))

    await waitFor(() =>
      expect(eventMetricsApi.markSignalExpected).toHaveBeenCalledWith(
        'demo',
        expect.objectContaining({ scope_ref: 'et-1' }),
        'Campaign launch',
      ),
    )
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Mark as expected' })).not.toBeInTheDocument(),
    )
  })

  it('offers the undo of each verdict a signal already carries', async () => {
    vi.mocked(eventMetricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ acknowledged_at: '2026-09-25T19:00:00Z', muted: true, hidden: true }),
    ])
    renderAnomalies('/p/demo/anomalies?hidden=1')
    await openMenu('Signup')

    expect(await screen.findByRole('menuitem', { name: 'Undo acknowledge' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unmute scope' }))
    await waitFor(() => expect(eventMetricsApi.unmuteSignalScope).toHaveBeenCalled())
  })
})

describe('AnomaliesPage — hidden signals (MO-4 / JR-5)', () => {
  const signals = [
    makeSignal({ scope_ref: 'et-1', scope_name: 'Signup' }),
    makeSignal({ scope_ref: 'et-2', event_type_id: 'et-2', scope_name: 'Checkout', muted: true, hidden: true }),
    makeSignal({ scope_ref: 'et-3', event_type_id: 'et-3', scope_name: 'Login', expected: true, hidden: true }),
    makeSignal({ scope_ref: 'et-4', event_type_id: 'et-4', scope_name: 'Search', acknowledged_at: '2026-09-25T19:00:00Z' }),
  ]

  it('leaves muted and expected signals out of the list and the counts by default', async () => {
    vi.mocked(eventMetricsApi.getActiveSignals).mockResolvedValue(signals)
    renderAnomalies()

    const table = await screen.findByRole('table', { name: 'Anomaly signals' })
    expect(within(table).getAllByRole('row')).toHaveLength(3) // header + Signup + Search
    expect(within(table).queryByText(/Checkout/)).not.toBeInTheDocument()
    // Acknowledged stays listed, and says so.
    expect(within(rowOf('Search')).getByText(/Acknowledged/)).toBeInTheDocument()
    expect(screen.getByText('2 open')).toBeInTheDocument()
  })

  it('brings hidden signals back, flagged, behind "Show hidden (n)"', async () => {
    vi.mocked(eventMetricsApi.getActiveSignals).mockResolvedValue(signals)
    renderAnomalies()

    const toggle = await screen.findByRole('button', { name: 'Show hidden (2)' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)

    expect(await screen.findByText('anomalies-location:?hidden=1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show hidden (2)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(rowOf('Checkout')).getByText(/Muted/)).toBeInTheDocument()
    expect(within(rowOf('Login')).getByText(/Expected/)).toBeInTheDocument()
  })

  it('counts only the hidden signals the magnitude level would show', async () => {
    // A muted Minor move (5% over baseline) is hidden too, but the default
    // Significant level keeps it out even with hidden signals shown, so it is
    // not part of the n the button promises.
    vi.mocked(eventMetricsApi.getActiveSignals).mockResolvedValue([
      ...signals,
      makeSignal({
        scope_ref: 'et-5',
        event_type_id: 'et-5',
        scope_name: 'Minor',
        actual_count: 42,
        expected_count: 40,
        muted: true,
        hidden: true,
      }),
    ])
    renderAnomalies()

    expect(await screen.findByRole('button', { name: 'Show hidden (2)' })).toBeInTheDocument()
  })

  it('offers "Show hidden" from the empty state when every open signal is hidden', async () => {
    vi.mocked(eventMetricsApi.getActiveSignals).mockResolvedValue(signals.slice(1, 2))
    renderAnomalies()

    expect(await screen.findByText('No anomalies right now')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden (1)' }))
    expect(await screen.findByText('anomalies-location:?hidden=1')).toBeInTheDocument()
  })
})
