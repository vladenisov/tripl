import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AlertDelivery } from '@/types'
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
