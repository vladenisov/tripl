import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
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

function renderRow(delivery: AlertDelivery, focusDeliveryId?: string, focusItemKey?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  // Router, because the row links to the scope an alert fired on with <Link>
  // for in-app navigation — in the app it is always mounted under one.
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <table>
          <tbody>
            <AlertDeliveryRow
              slug="demo"
              delivery={delivery}
              focusDeliveryId={focusDeliveryId}
              focusItemKey={focusItemKey}
            />
          </tbody>
        </table>
      </MemoryRouter>
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

  it('links each item to the scope it fired on', async () => {
    expandRow({ ...mockDelivery({ status: 'sent', error_message: null }), items: [mockItem()] })

    // Derived from the item's own scope rather than read from `monitoring_path`,
    // which alerts stopped filling once they began pointing at the incident.
    // Without this the card showed the alert and no way to look at the thing
    // that caused it.
    const link = await screen.findByRole('link', { name: 'Open checkout_completed' })
    expect(link).toHaveAttribute('href', '/p/demo/monitoring/event/checkout_completed')
  })

  it('does not offer a link back to the page the reader is already on', async () => {
    expandRow({
      ...mockDelivery({ status: 'sent', error_message: null }),
      items: [
        mockItem({
          details_path: 'https://tripl.example.com/p/demo/settings/alerting/delivery-1?item=event:x',
        }),
      ],
    })

    await screen.findByRole('link', { name: 'Open checkout_completed' })
    // `details_path` is the incident deep link an alert message carries. It is
    // useful in telegram and pointless in a cell on the page it names.
    expect(screen.queryByRole('link', { name: /^Details for/ })).toBeNull()
  })

  it('falls back to a dash when the scope has nowhere to link', async () => {
    expandRow({
      ...mockDelivery({ status: 'sent', error_message: null }),
      items: [
        // A schema drift: no monitoring route of its own, and no event behind it.
        mockItem({ scope_type: 'schema', scope_name: 'missing_field', event_id: null }),
      ],
    })

    expect(await screen.findByText('missing_field')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^Open / })).toBeNull()
  })

  it('shows the percentage for an item that had a baseline', async () => {
    expandRow({ ...mockDelivery({ status: 'sent', error_message: null }), items: [mockItem()] })

    expect(await screen.findByText('70.0%')).toBeInTheDocument()
  })

  it('says there was no baseline instead of claiming a 0% change', async () => {
    // The percent gate deliberately admits zero-baseline anomalies
    // (tripl-l429.12) and the stored percent_delta is 0.0 for them because the
    // ratio is undefined — the same value the alert message renders, so the two
    // must read the same (tripl-l429.24).
    expandRow({
      ...mockDelivery({ status: 'sent', error_message: null }),
      items: [
        mockItem({
          direction: 'spike',
          actual_count: 137,
          expected_count: 0,
          absolute_delta: 137,
          percent_delta: 0,
        }),
      ],
    })

    expect(await screen.findByText('no baseline')).toBeInTheDocument()
    expect(screen.queryByText('0.0%')).toBeNull()
  })
})

// The destination of the deep link an alert message carries for release
// regressions. Landing here has to SHOW the numbers the message quoted —
// otherwise the link is no better than the event page it replaced.
describe('AlertDeliveryRow deep link', () => {
  function stubDetail(detail: AlertDeliveryDetail) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).endsWith('/alert-deliveries/delivery-1')) {
        return mockJsonResponse(detail)
      }
      throw new Error(`Unhandled fetch: ${String(input)}`)
    })
  }

  const releaseRegressionItem = mockItem({
    scope_type: 'release_regression',
    scope_name: 'spot:open:wind:',
    actual_count: 345,
    expected_count: 715.7,
    absolute_delta: 370.7,
    percent_delta: 51.8,
    drift_field: '15.7.5',
    drift_type: 'volume_drop',
    sample_value: '15.7.4',
  })

  it('opens the linked delivery without a click', async () => {
    // The link exists to show one delivery's per-scope rows. A collapsed row
    // hides exactly those, so arriving collapsed defeats the link.
    stubDetail({ ...mockDelivery({ status: 'sent', error_message: null }), items: [releaseRegressionItem] })
    renderRow(mockDelivery({ status: 'sent', error_message: null }), 'delivery-1')

    expect(await screen.findByText('spot:open:wind:')).toBeInTheDocument()
    expect(screen.getByText('345')).toBeInTheDocument()
    expect(screen.getByText('715.7')).toBeInTheDocument()
  })

  it('stays collapsed when the link names a different delivery', async () => {
    renderRow(mockDelivery({ status: 'sent', error_message: null }), 'delivery-999')

    expect(
      screen.getByRole('button', { name: 'Expand delivery details' }),
    ).toHaveAttribute('aria-expanded', 'false')
  })

  it('says what the expected count is, so the page cannot re-teach the count reading', async () => {
    // "actual 345 / expected 715.7" side by side reads as two counts of one
    // thing, which is the misreading the alert message was changed to prevent.
    // The page the message links to must not undo that.
    stubDetail({ ...mockDelivery({ status: 'sent', error_message: null }), items: [releaseRegressionItem] })
    renderRow(mockDelivery({ status: 'sent', error_message: null }), 'delivery-1')

    expect(
      await screen.findByText(/Adoption-adjusted: 15\.7\.4's share of this scope at 15\.7\.5's own volume/),
    ).toBeInTheDocument()
    expect(screen.getByText(/share-for-share, not a raw count drop/)).toBeInTheDocument()
  })

  it('leaves the expected count of every other scope unannotated', async () => {
    stubDetail({ ...mockDelivery({ status: 'sent', error_message: null }), items: [mockItem()] })
    renderRow(mockDelivery({ status: 'sent', error_message: null }), 'delivery-1')

    expect(await screen.findByText('checkout_completed')).toBeInTheDocument()
    expect(screen.queryByText(/Adoption-adjusted/)).toBeNull()
  })
})

// A telegram delivery carries up to 8 items (_MAX_ITEMS_PER_DELIVERY), and every
// one of those lines printed the same delivery-keyed URL. Landing on the row was
// therefore landing on 8 siblings with nothing marking the one the message
// quoted. `?item=<scope_type>:<scope_ref>` names it.
describe('AlertDeliveryRow per-item anchor', () => {
  const sent = () => mockDelivery({ status: 'sent', error_message: null, matched_count: 3 })

  // Three items, two of which share a scope_ref: a release regression's
  // scope_ref IS its event id, and one rule can include events AND release
  // regressions, so this shape is reachable, not contrived.
  const items: AlertDeliveryItem[] = [
    mockItem({ id: 'item-1', scope_type: 'event', scope_ref: 'evt-a', scope_name: 'Login' }),
    mockItem({
      id: 'item-2',
      scope_type: 'release_regression',
      scope_ref: 'evt-a',
      scope_name: 'spot:open:wind:',
    }),
    mockItem({
      id: 'item-3',
      scope_type: 'release_regression',
      scope_ref: 'evt-b',
      scope_name: 'spot:open:swell:',
    }),
  ]

  function stubItems() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (String(input).endsWith('/alert-deliveries/delivery-1')) {
        return mockJsonResponse({ ...sent(), items })
      }
      throw new Error(`Unhandled fetch: ${String(input)}`)
    })
  }

  function rowFor(scopeName: string): HTMLElement {
    const cell = screen.getByText(scopeName).closest('tr')
    if (!cell) throw new Error(`No row for ${scopeName}`)
    return cell
  }

  it('marks the one row the alert line was about', async () => {
    stubItems()
    renderRow(sent(), 'delivery-1', 'release_regression:evt-b')

    expect(await screen.findByText('spot:open:swell:')).toBeInTheDocument()
    expect(rowFor('spot:open:swell:')).toHaveAttribute('aria-current', 'true')
    expect(rowFor('spot:open:wind:')).not.toHaveAttribute('aria-current')
    expect(rowFor('Login')).not.toHaveAttribute('aria-current')
  })

  it('names the marked row in text, not only as a tint', async () => {
    // A background tint among 8 rows is easy to miss and says nothing at all to
    // a screen reader, so the row states why it is marked.
    stubItems()
    renderRow(sent(), 'delivery-1', 'release_regression:evt-b')

    expect(await screen.findByText('from your alert')).toBeInTheDocument()
    expect(rowFor('spot:open:swell:')).toHaveTextContent('from your alert')
  })

  it('does not mark a sibling that merely shares the scope_ref', async () => {
    // The exact reason the anchor carries scope_type: `evt-a` belongs to both
    // the event item and the release regression in this delivery.
    stubItems()
    renderRow(sent(), 'delivery-1', 'release_regression:evt-a')

    expect(await screen.findByText('spot:open:wind:')).toBeInTheDocument()
    expect(rowFor('spot:open:wind:')).toHaveAttribute('aria-current', 'true')
    expect(rowFor('Login')).not.toHaveAttribute('aria-current')
  })

  it('marks nothing when the anchor names an item this delivery does not have', async () => {
    // Stale links must degrade to the delivery-level behaviour they had before
    // anchors existed, not mark an arbitrary row.
    stubItems()
    renderRow(sent(), 'delivery-1', 'release_regression:evt-gone')

    expect(await screen.findByText('spot:open:wind:')).toBeInTheDocument()
    expect(screen.queryByText('from your alert')).toBeNull()
  })

  it('ignores an anchor meant for a different delivery', async () => {
    stubItems()
    renderRow(sent(), 'delivery-999', 'release_regression:evt-b')

    expect(
      screen.getByRole('button', { name: 'Expand delivery details' }),
    ).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('from your alert')).toBeNull()
  })
})
