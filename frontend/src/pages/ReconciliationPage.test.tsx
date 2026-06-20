import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CoverageResponse,
  DeadEventsResponse,
  ShadowEventStatus,
  ShadowEventsResponse,
} from '@/api/reconciliation'
import ReconciliationPage from './ReconciliationPage'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const coverage: CoverageResponse = {
  days: 14,
  summary: { total_count: 132, matched_count: 124, coverage_pct: 94.2 },
  items: [
    { bucket: '2026-06-01', total_count: 100, matched_count: 95 }, // 95% accent
    { bucket: '2026-06-02', total_count: 100, matched_count: 80 }, // 80% warning
    { bucket: '2026-06-03', total_count: 100, matched_count: 50 }, // 50% danger
  ],
}

const shadowNew: ShadowEventsResponse = {
  total: 1,
  new_count: 1,
  items: [
    {
      id: 'sh1',
      scan_config_id: 'scan-1',
      scan_config_name: 'iOS Prod',
      event_type_id: null,
      event_type_name: null,
      event_name: 'variant_color_selected',
      observed_count: 8420,
      first_seen_at: '2026-06-17T11:00:00Z',
      last_seen_at: '2026-06-17T11:56:00Z',
      status: 'new',
      accepted_event_id: null,
    },
  ],
}

const emptyShadow: ShadowEventsResponse = { total: 0, new_count: 0, items: [] }

const dead: DeadEventsResponse = {
  days: 30,
  total: 2,
  items: [
    {
      event_id: 'd1',
      name: 'legacy_banner_shown',
      event_type_id: 'et-1',
      event_type_name: 'notification',
      last_seen_at: '2026-05-10T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      event_id: 'd2',
      name: 'promo_code_invalid',
      event_type_id: 'et-2',
      event_type_name: 'checkout',
      last_seen_at: null,
      created_at: '2026-01-01T00:00:00Z',
    },
  ],
}

function statusFromUrl(url: string): ShadowEventStatus {
  if (url.includes('status=accepted')) return 'accepted'
  if (url.includes('status=dismissed')) return 'dismissed'
  return 'new'
}

function mockFetch(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('/reconciliation/coverage')) return jsonResponse(coverage)
    if (url.includes('/reconciliation/dead-events')) return jsonResponse(dead)
    if (url.includes('/reconciliation/shadow-events')) {
      return jsonResponse(statusFromUrl(url) === 'new' ? shadowNew : emptyShadow)
    }
    if (url.includes('/event-types')) return jsonResponse([])
    throw new Error(`Unhandled fetch: ${url}`)
  })
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/demo/reconciliation']}>
        <Routes>
          <Route path="/p/:slug/reconciliation" element={<ReconciliationPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ReconciliationPage', () => {
  it('renders the coverage hero and govern header', async () => {
    mockFetch()
    renderPage()

    expect(screen.getByText('Govern')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Reconciliation' })).toBeInTheDocument()
    expect(
      screen.getByText(
        'Compare what your plan defines against what your data sources actually send.',
      ),
    ).toBeInTheDocument()
    expect(await screen.findByText('94%')).toBeInTheDocument()
    expect(screen.getByText('matched coverage')).toBeInTheDocument()
    expect(screen.getByText('124 of 132 planned events seen in data · 14d')).toBeInTheDocument()
  })

  it('renders shadow inbox rows with accept/dismiss actions', async () => {
    mockFetch()
    renderPage()

    expect(await screen.findByText('variant_color_selected')).toBeInTheDocument()
    expect(screen.getByText(/8,420 seen/)).toBeInTheDocument()
    expect(screen.getByText('no type')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })

  it('renders dead events with a never-seen danger marker', async () => {
    mockFetch()
    renderPage()

    expect(await screen.findByText('legacy_banner_shown')).toBeInTheDocument()
    expect(screen.getByText('promo_code_invalid')).toBeInTheDocument()
    const neverRows = screen.getAllByText('never')
    expect(neverRows.length).toBeGreaterThan(0)
  })

  it('switches shadow tabs to show the per-tab empty state', async () => {
    mockFetch()
    renderPage()

    await screen.findByText('variant_color_selected')
    fireEvent.click(screen.getByRole('button', { name: 'accepted' }))

    expect(await screen.findByText('No accepted events.')).toBeInTheDocument()
  })

  it('prompts to choose an event type before accepting an untyped shadow event', async () => {
    mockFetch()
    renderPage()

    await screen.findByText('variant_color_selected')
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))

    expect(await screen.findByText('Choose event type:')).toBeInTheDocument()
    const select = screen.getByRole('combobox')
    expect(within(select).getByText('Select…')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
    })
  })
})
