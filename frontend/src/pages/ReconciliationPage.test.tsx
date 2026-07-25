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
    { bucket: '2026-06-01', total_count: 100, matched_count: 95 }, // 95% success
    { bucket: '2026-06-02', total_count: 100, matched_count: 80 }, // 80% warning
    { bucket: '2026-06-03', total_count: 100, matched_count: 50 }, // 50% danger
  ],
}

// Every bucket sits at 100% — no per-day variation, so the panel should switch
// from the dense histogram to a thin steady sparkline.
const steadyCoverage: CoverageResponse = {
  days: 14,
  summary: { total_count: 120, matched_count: 120, coverage_pct: 100 },
  items: [
    { bucket: '2026-06-01', total_count: 50, matched_count: 50 },
    { bucket: '2026-06-02', total_count: 80, matched_count: 80 },
    { bucket: '2026-06-03', total_count: 60, matched_count: 60 },
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
    // The metric drops the word "coverage" so it no longer collides with the
    // dashboard's plan-coverage KPI — it now reads as "seen in data".
    expect(screen.getByText('Data match')).toBeInTheDocument()
    expect(screen.getByText('seen in data')).toBeInTheDocument()
    // The headline carries an inline clarifier so it can't be misread as the
    // Coverage page's plan-coverage KPI — they measure different things.
    expect(screen.getByTitle(/seen in warehouse data/i)).toBeInTheDocument()
    expect(screen.queryByText('data-match coverage')).not.toBeInTheDocument()
    expect(screen.getByText('124 of 132 planned events seen in data · 14d')).toBeInTheDocument()
  })

  it('formats large data-match counts with thousand separators', async () => {
    const bigCoverage: CoverageResponse = {
      days: 14,
      summary: { total_count: 89327935, matched_count: 89327935, coverage_pct: 100 },
      items: [{ bucket: '2026-06-01', total_count: 89327935, matched_count: 89327935 }],
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/reconciliation/coverage')) return jsonResponse(bigCoverage)
      if (url.includes('/reconciliation/dead-events')) return jsonResponse(dead)
      if (url.includes('/reconciliation/shadow-events')) return jsonResponse(emptyShadow)
      if (url.includes('/event-types')) return jsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
    renderPage()

    expect(
      await screen.findByText('89,327,935 of 89,327,935 planned events seen in data · 14d'),
    ).toBeInTheDocument()
    // The raw, separator-free rendering must not appear.
    expect(
      screen.queryByText('89327935 of 89327935 planned events seen in data · 14d'),
    ).not.toBeInTheDocument()
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

  it('renders the dead-events explanation and a calm amber (not danger-red) never marker', async () => {
    mockFetch()
    renderPage()

    expect(await screen.findByText('legacy_banner_shown')).toBeInTheDocument()
    expect(screen.getByText('promo_code_invalid')).toBeInTheDocument()
    // A one-line explanation reassures that dead events are often expected.
    expect(
      screen.getByText('Planned events not seen in your data recently — often expected.'),
    ).toBeInTheDocument()
    // "never" reads as a calm amber, never as an alarming danger-red wall.
    const neverRows = screen.getAllByText('never')
    expect(neverRows.length).toBeGreaterThan(0)
    expect(neverRows[0]).toHaveStyle({ color: 'var(--warning)' })
    expect(neverRows[0]).not.toHaveStyle({ color: 'var(--danger)' })
  })

  it('renders 0-encoded empty segments as a placeholder, never a bare "0"', async () => {
    const deadZero: DeadEventsResponse = {
      days: 30,
      total: 1,
      items: [
        {
          event_id: 'z1',
          name: '0:forecast_for_4:0',
          event_type_id: '',
          event_type_name: '',
          last_seen_at: '2026-05-01T00:00:00Z',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/reconciliation/coverage')) return jsonResponse(coverage)
      if (url.includes('/reconciliation/dead-events')) return jsonResponse(deadZero)
      if (url.includes('/reconciliation/shadow-events')) return jsonResponse(emptyShadow)
      if (url.includes('/event-types')) return jsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
    renderPage()

    expect(await screen.findByText('forecast_for_4')).toBeInTheDocument()
    // The "0" segments collapse to muted placeholders — no confusing standalone "0".
    expect(screen.queryByText('0')).not.toBeInTheDocument()
    expect(screen.getAllByTitle('empty segment')).toHaveLength(2)
  })

  it('renders colon-delimited dead-event names with a placeholder for empty segments', async () => {
    const deadColon: DeadEventsResponse = {
      days: 30,
      total: 2,
      items: [
        {
          event_id: 'c1',
          name: ':forecast_for_4',
          event_type_id: '',
          event_type_name: '',
          last_seen_at: '2026-05-01T00:00:00Z',
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          event_id: 'c2',
          name: 'buoy:copy:coordinates(main)',
          event_type_id: '',
          event_type_name: '',
          last_seen_at: '2026-05-02T00:00:00Z',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/reconciliation/coverage')) return jsonResponse(coverage)
      if (url.includes('/reconciliation/dead-events')) return jsonResponse(deadColon)
      if (url.includes('/reconciliation/shadow-events')) return jsonResponse(emptyShadow)
      if (url.includes('/event-types')) return jsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
    renderPage()

    // A leading empty segment splits the name and surfaces its non-empty piece.
    expect(await screen.findByText('forecast_for_4')).toBeInTheDocument()
    // A name with no empty segment renders as-is (matching the Events list).
    expect(screen.getByText('buoy:copy:coordinates(main)')).toBeInTheDocument()
    // The leading empty segment renders an intentional placeholder, not a blank.
    expect(screen.getByTitle('empty segment')).toBeInTheDocument()
  })

  it('gives each dead-event row a full-name tooltip so ellipsized long names stay distinguishable', async () => {
    // Real names share a long common prefix and only differ near the end, so the
    // truncated rows look identical — the title exposes the full name on hover.
    const longNo = 'page_value_question_page_value_page_value_sail_navigation_interface_no_selected'
    const longYes = 'page_value_question_page_value_page_value_sail_navigation_interface_yes_selected'
    const deadLong: DeadEventsResponse = {
      days: 30,
      total: 2,
      items: [
        {
          event_id: 'l1',
          name: longNo,
          event_type_id: 'et-1',
          event_type_name: 'nav',
          last_seen_at: '2026-05-10T00:00:00Z',
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          event_id: 'l2',
          name: longYes,
          event_type_id: 'et-1',
          event_type_name: 'nav',
          last_seen_at: '2026-05-11T00:00:00Z',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/reconciliation/coverage')) return jsonResponse(coverage)
      if (url.includes('/reconciliation/dead-events')) return jsonResponse(deadLong)
      if (url.includes('/reconciliation/shadow-events')) return jsonResponse(emptyShadow)
      if (url.includes('/event-types')) return jsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
    renderPage()

    // Each row carries its own full name as a native tooltip on the link.
    expect(await screen.findByTitle(longNo)).toHaveAttribute('title', longNo)
    expect(screen.getByTitle(longYes)).toHaveAttribute('title', longYes)
  })

  it('shows a reassuring compact empty state when the new shadow inbox is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/reconciliation/coverage')) return jsonResponse(coverage)
      if (url.includes('/reconciliation/dead-events')) return jsonResponse(dead)
      if (url.includes('/reconciliation/shadow-events')) return jsonResponse(emptyShadow)
      if (url.includes('/event-types')) return jsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
    renderPage()

    expect(await screen.findByText('No new events')).toBeInTheDocument()
    expect(
      screen.getByText('No unexpected events seen in the last 14 days.'),
    ).toBeInTheDocument()
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

  it('shows a thin steady sparkline (not the per-day histogram) when data-match is constant', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/reconciliation/coverage')) return jsonResponse(steadyCoverage)
      if (url.includes('/reconciliation/dead-events')) return jsonResponse(dead)
      if (url.includes('/reconciliation/shadow-events')) return jsonResponse(emptyShadow)
      if (url.includes('/event-types')) return jsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
    renderPage()

    // The big number still anchors the panel and conveys the level.
    expect(await screen.findByText('100%')).toBeInTheDocument()
    // A steady line replaces the histogram when coverage never varies.
    expect(
      screen.getByRole('img', { name: /steady at 100% across the window/i }),
    ).toBeInTheDocument()
    // No per-bucket histogram bars are rendered in the steady layout.
    expect(screen.queryByTitle(/2026-06-01:/)).not.toBeInTheDocument()
  })

  it('keeps the per-day histogram (no steady sparkline) when coverage varies', async () => {
    mockFetch()
    renderPage()

    // The default fixture varies (95 / 80 / 50), so the histogram bars remain.
    expect(await screen.findByTitle('2026-06-01: 95%')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /steady at/i })).not.toBeInTheDocument()
  })

  it('select-all toggles every dead row and reflects the count on the archive action', async () => {
    mockFetch()
    renderPage()

    await screen.findByText('legacy_banner_shown')
    // With nothing selected the bulk action is present but disabled.
    expect(screen.getByRole('button', { name: 'Archive selected' })).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all dead events' }))

    const archiveBtn = screen.getByRole('button', { name: 'Archive 2 selected' })
    expect(archiveBtn).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'Select legacy_banner_shown' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Select promo_code_invalid' })).toBeChecked()
  })

  it('archives selected dead events and refetches the recon list', async () => {
    const archiveCalls: Array<{ url: string; body: { event_ids: string[]; status: string } }> = []
    let deadPayload: DeadEventsResponse = dead
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/reconciliation/coverage')) return jsonResponse(coverage)
      // The archive POST must be matched before the generic dead-events GET.
      if (url.includes('/reconciliation/dead-events/archive')) {
        const body = JSON.parse(String(init?.body)) as { event_ids: string[]; status: string }
        archiveCalls.push({ url, body })
        // Simulate the server archiving the ids: they drop out of the next list.
        deadPayload = {
          ...dead,
          total: dead.items.length - body.event_ids.length,
          items: dead.items.filter((d) => !body.event_ids.includes(d.event_id)),
        }
        return jsonResponse({
          event_ids: body.event_ids,
          status: body.status,
          archived_count: body.event_ids.length,
        })
      }
      if (url.includes('/reconciliation/dead-events')) return jsonResponse(deadPayload)
      if (url.includes('/reconciliation/shadow-events')) return jsonResponse(emptyShadow)
      if (url.includes('/event-types')) return jsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
    renderPage()

    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Select legacy_banner_shown' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Archive 1 selected' }))

    await waitFor(() => expect(archiveCalls).toHaveLength(1))
    expect(archiveCalls[0].url).toContain('/reconciliation/dead-events/archive')
    expect(archiveCalls[0].body).toEqual({ event_ids: ['d1'], status: 'archived' })

    // After invalidation the archived row is gone; the untouched row survives.
    await waitFor(() => {
      expect(screen.queryByText('legacy_banner_shown')).not.toBeInTheDocument()
    })
    expect(screen.getByText('promo_code_invalid')).toBeInTheDocument()
  })

  it('surfaces an error and keeps the selection when archive fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/reconciliation/coverage')) return jsonResponse(coverage)
      if (url.includes('/reconciliation/dead-events/archive')) {
        return new Response(JSON.stringify({ detail: 'Event not found on branch' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/reconciliation/dead-events')) return jsonResponse(dead)
      if (url.includes('/reconciliation/shadow-events')) return jsonResponse(emptyShadow)
      if (url.includes('/event-types')) return jsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
    renderPage()

    fireEvent.click(
      await screen.findByRole('checkbox', { name: 'Select legacy_banner_shown' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Archive 1 selected' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Event not found on branch')
    // The row and its selection persist so the user can retry.
    expect(screen.getByText('legacy_banner_shown')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Archive 1 selected' })).toBeInTheDocument()
  })
})
