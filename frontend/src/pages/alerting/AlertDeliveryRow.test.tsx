import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AlertDelivery, AlertDeliveryDetail, AlertDeliveryItem } from '@/types'
import { AlertDeliveryRow } from './AlertDeliveryRow'

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockDelivery(overrides: Partial<AlertDelivery> = {}): AlertDelivery {
  return {
    id: 'delivery-1',
    project_id: 'project-1',
    scan_config_id: 'scan-1',
    scan_job_id: null,
    destination_id: 'destination-1',
    rule_id: 'rule-1',
    destination_name: 'Ops',
    rule_name: 'Spike alerts',
    scan_name: 'Main scan',
    status: 'failed',
    channel: 'slack',
    is_local: false,
    is_simulated: false,
    matched_count: 1,
    payload_snapshot: null,
    error_message: 'Webhook failed',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    sent_at: null,
    ...overrides,
  }
}

function mockItem(overrides: Partial<AlertDeliveryItem> = {}): AlertDeliveryItem {
  return {
    id: 'item-1',
    delivery_id: 'delivery-1',
    scope_type: 'event',
    scope_ref: 'checkout_completed',
    scope_name: 'checkout_completed',
    event_type_id: null,
    event_id: 'event-1',
    bucket: '2026-01-01T00:00:00Z',
    direction: 'drop',
    actual_count: 12,
    expected_count: 40,
    absolute_delta: 28,
    percent_delta: 70,
    details_path: null,
    monitoring_path: null,
    drift_field: null,
    drift_type: null,
    sample_value: null,
    correlation_group_id: null,
    ...overrides,
  }
}

function renderRow(delivery: AlertDelivery) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <table>
        <tbody>
          <AlertDeliveryRow slug="demo" delivery={delivery} />
        </tbody>
      </table>
    </QueryClientProvider>,
  )
}

// Expanding the row is what fires the detail GET, so every items-table test
// stubs that one endpoint and then clicks the chevron.
function expandRow(detail: AlertDeliveryDetail) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/alert-deliveries/delivery-1') && (init?.method ?? 'GET') === 'GET') {
      return mockJsonResponse(detail)
    }
    throw new Error(`Unhandled fetch: ${init?.method} ${url}`)
  })
  renderRow(detail)
  fireEvent.click(screen.getByRole('button', { name: 'Expand delivery details' }))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AlertDeliveryRow retry', () => {
  it('renders a Retry control only for failed deliveries', () => {
    renderRow(mockDelivery({ status: 'sent', error_message: null }))
    expect(screen.queryByRole('button', { name: 'Retry delivery' })).toBeNull()
  })

  it('shows the Retry control for failed deliveries', () => {
    renderRow(mockDelivery({ status: 'failed' }))
    expect(screen.getByRole('button', { name: 'Retry delivery' })).toBeInTheDocument()
  })

  it('re-queues a failed delivery via the retry endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/alert-deliveries/delivery-1/retry') && init?.method === 'POST') {
        return mockJsonResponse({ ...mockDelivery({ status: 'pending', error_message: null }), items: [] })
      }
      throw new Error(`Unhandled fetch: ${init?.method} ${url}`)
    })

    renderRow(mockDelivery({ status: 'failed' }))

    fireEvent.click(screen.getByRole('button', { name: 'Retry delivery' }))

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/v1/projects/demo/alert-deliveries/delivery-1/retry',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('surfaces a retry failure inline via role=alert', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/alert-deliveries/delivery-1/retry') && init?.method === 'POST') {
        return mockJsonResponse({ detail: 'Delivery is not in failed status' }, 409)
      }
      throw new Error(`Unhandled fetch: ${init?.method} ${url}`)
    })

    renderRow(mockDelivery({ status: 'failed' }))

    fireEvent.click(screen.getByRole('button', { name: 'Retry delivery' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Retry failed: Delivery is not in failed status',
      )
    })
  })
})

describe('AlertDeliveryRow items table', () => {
  it('explains an empty item list instead of rendering a bare header row', async () => {
    // The seeded demo failure has exactly this shape — matched_count copied from
    // the incident, zero items of its own — and used to render eight headers over
    // nothing beside a "4" in the Matched column (tripl-gsom).
    expandRow({ ...mockDelivery({ matched_count: 4 }), items: [] })

    expect(
      await screen.findByText(
        'No per-scope rows were stored with this attempt — its 4 matched scopes are recorded on the attempt that carried the same incident.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Scope' })).toBeNull()
  })

  it('says nothing about a sibling attempt when the delivery matched nothing', async () => {
    expandRow({ ...mockDelivery({ matched_count: 0 }), items: [] })

    expect(
      await screen.findByText('This delivery matched nothing, so it has no per-scope rows.'),
    ).toBeInTheDocument()
  })

  it('renders one row per item when the delivery owns its item list', async () => {
    expandRow({
      ...mockDelivery({ status: 'sent', error_message: null, matched_count: 2 }),
      items: [
        mockItem(),
        mockItem({ id: 'item-2', scope_ref: 'signup_started', scope_name: 'signup_started', direction: 'spike' }),
      ],
    })

    expect(await screen.findByText('checkout_completed')).toBeInTheDocument()
    expect(screen.getByText('signup_started')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Scope' })).toBeInTheDocument()
    expect(screen.queryByText(/No per-scope rows were stored/)).toBeNull()
  })
})
