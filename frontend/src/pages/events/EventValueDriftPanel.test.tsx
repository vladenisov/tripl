import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { variableDriftsApi } from '@/api/variableDrifts'
import { EventValueDriftPanel } from './EventValueDriftPanel'

vi.mock('@/api/variableDrifts', () => ({
  variableDriftsApi: {
    list: vi.fn(),
    action: vi.fn(),
  },
}))

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <EventValueDriftPanel slug="demo" eventId="ev-1" />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

const DRIFT = {
  id: 'drift-1',
  variable_id: 'var-1',
  variable_name: 'variant',
  event_id: 'ev-1',
  event_name: 'Onboarding',
  scan_config_id: null,
  observed_values: ['x', 'y'],
  status: 'open' as const,
  resolution_note: null,
  snoozed_until: null,
  resolved_at: null,
  resolved_by: null,
  detected_at: '2026-07-09T00:00:00Z',
}

describe('EventValueDriftPanel', () => {
  it('renders nothing when the event has no active drift', async () => {
    vi.mocked(variableDriftsApi.list).mockResolvedValue({ items: [], total: 0 })
    const { container } = renderPanel()
    await waitFor(() => expect(variableDriftsApi.list).toHaveBeenCalledWith('demo', { eventId: 'ev-1' }, null))
    expect(container).toBeEmptyDOMElement()
  })

  it('lists novel values and accepts them for the event', async () => {
    vi.mocked(variableDriftsApi.list).mockResolvedValue({ items: [DRIFT], total: 1 })
    vi.mocked(variableDriftsApi.action).mockResolvedValue({ ...DRIFT, status: 'accepted' })

    renderPanel()
    expect(await screen.findByText('${variant}')).toBeInTheDocument()
    expect(screen.getByText('x')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Accept for event' }))
    await waitFor(() =>
      expect(variableDriftsApi.action).toHaveBeenCalledWith(
        'demo',
        'drift-1',
        { action: 'accept', scope: 'event', snoozed_until: undefined },
        null,
      ),
    )
  })

  it('reveals an accepted drift behind the resolved toggle and reopens it', async () => {
    const accepted = {
      ...DRIFT,
      id: 'drift-2',
      status: 'accepted' as const,
      observed_values: ['q'],
    }
    vi.mocked(variableDriftsApi.list).mockResolvedValue({ items: [accepted], total: 1 })
    vi.mocked(variableDriftsApi.action).mockResolvedValue({ ...accepted, status: 'open' })

    renderPanel()

    // Resolved rows are collapsed, not hidden: the panel still renders.
    fireEvent.click(await screen.findByRole('button', { name: 'Show 1 resolved' }))
    expect(await screen.findByText('q')).toBeInTheDocument()
    expect(screen.getByText('accepted')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await waitFor(() =>
      expect(variableDriftsApi.action).toHaveBeenCalledWith(
        'demo',
        'drift-2',
        { action: 'reopen', scope: undefined, snoozed_until: undefined },
        null,
      ),
    )
  })
})
