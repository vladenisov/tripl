import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { alertingApi } from '@/api/alerting'
import type { AlertDelivery } from '@/types'

import { IncidentDeliveries } from './IncidentDeliveries'

vi.mock('@/api/alerting', () => ({
  alertingApi: {
    listDeliveries: vi.fn(),
    retryDelivery: vi.fn(),
    getDelivery: vi.fn(),
  },
}))

const GROUP_ID = 'aa11bb22-cc33-dd44-ee55-ff6677889900'

function makeDelivery(overrides: Partial<AlertDelivery> = {}): AlertDelivery {
  return {
    id: 'delivery-1',
    project_id: 'p-1',
    scan_config_id: 's-1',
    destination_id: 'd-1',
    rule_id: 'r-1',
    destination_name: 'Ops Telegram',
    rule_name: 'Prod drops',
    scan_name: 'Snowplow Events (iOS)',
    channel: 'telegram',
    status: 'sent',
    matched_count: 1,
    error_message: null,
    payload_snapshot: { preview: 'checkout:completed -62%' },
    sent_at: '2026-08-11T20:14:00Z',
    created_at: '2026-08-11T20:14:00Z',
    updated_at: '2026-08-11T20:14:00Z',
    ...overrides,
  } as AlertDelivery
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <IncidentDeliveries slug="demo" correlationGroupId={GROUP_ID} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('IncidentDeliveries', () => {
  it('asks for this incident only, and lists what it sent', async () => {
    vi.mocked(alertingApi.listDeliveries).mockResolvedValue({
      items: [makeDelivery()],
      total: 1,
    })

    renderCard()

    expect(await screen.findByText('Ops Telegram')).toBeInTheDocument()
    // Scoped server-side: the incident lives on the delivery ITEM, so the page
    // cannot get this by filtering a list it already holds.
    expect(alertingApi.listDeliveries).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({ correlation_group_id: GROUP_ID }),
    )
  })

  it('says a failed request failed, instead of reporting nothing was sent', async () => {
    vi.mocked(alertingApi.listDeliveries).mockRejectedValue(new Error('boom'))

    renderCard()

    // "No delivery recorded" and "the request failed" are opposite facts about
    // an incident someone is deciding whether to acknowledge. Showing the
    // reassuring one on no evidence is the bug this guards (PR #104 review).
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load deliveries')
    expect(screen.queryByText(/No delivery recorded/)).not.toBeInTheDocument()
  })

  it('reports an empty incident as empty', async () => {
    vi.mocked(alertingApi.listDeliveries).mockResolvedValue({ items: [], total: 0 })

    renderCard()

    expect(await screen.findByText(/No delivery recorded for this incident/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
