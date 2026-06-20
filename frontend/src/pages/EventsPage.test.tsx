import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EventsPage from './EventsPage'
import EventEditPage from './events/EventForm'

vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts')
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  }
})

function mockJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    project_id: 'project-1',
    event_type_id: 'type-1',
    event_type: { id: 'type-1', name: 'page', display_name: 'Page', color: '#0ea5e9' },
    name: 'Homepage View',
    description: '',
    order: 0,
    status: 'live',
    sunset_at: null,
    tags: [],
    field_values: [],
    meta_values: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function renderEventsPage(initialEntries: string[] = ['/p/demo/events']) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/p/:slug/events" element={<EventsPage />} />
          <Route path="/p/:slug/events/:tab/new" element={<EventEditPage />} />
          <Route path="/p/:slug/events/:tab/:eventId/edit" element={<EventEditPage />} />
          <Route path="/p/:slug/events/:tab" element={<EventsPage />} />
          <Route path="/p/:slug/events/:tab/:eventId" element={<EventsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('EventsPage', () => {
  it('renders monitoring signal links for active view and rows', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

      if (url.endsWith('/api/v1/projects/demo/event-types')) {
        return mockJsonResponse([
          {
            id: 'type-1',
            project_id: 'project-1',
            name: 'page',
            display_name: 'Page',
            description: '',
            color: '#0ea5e9',
            order: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            field_definitions: [],
          },
        ])
      }
      if (url.endsWith('/api/v1/projects/demo/meta-fields')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/variables')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/events/tags')) return mockJsonResponse([])
      // unreviewedCount query: exactly status=in_review with limit=1
      if (url.includes('/api/v1/projects/demo/events') && url.includes('status=in_review') && url.includes('limit=1')) {
        return mockJsonResponse({ items: [], total: 0 })
      }
      if (url.includes('/api/v1/projects/demo/events-metrics')) {
        return mockJsonResponse({
          scope: 'events_total',
          scan_config_id: null,
          event_id: null,
          event_type_id: null,
          interval: '1h',
          latest_signal: null,
          data: [],
        })
      }
      if (url.endsWith('/api/v1/projects/demo/events/window-metrics') && init?.method === 'POST') {
        return mockJsonResponse([
          {
            event_id: 'event-1',
            scan_config_id: 'scan-1',
            interval: '1h',
            total_count: 1200,
            data: [
              {
                bucket: '2026-01-01T00:00:00Z',
                count: 500,
                expected_count: null,
                is_anomaly: false,
                anomaly_direction: null,
                z_score: null,
              },
              {
                bucket: '2026-01-01T12:00:00Z',
                count: 700,
                expected_count: null,
                is_anomaly: false,
                anomaly_direction: null,
                z_score: null,
              },
            ],
          },
        ])
      }
      if (url.includes('/api/v1/projects/demo/anomalies/signals')) {
        return mockJsonResponse([
          {
            scan_config_id: 'scan-1',
            scope_type: 'project_total',
            scope_ref: 'scan-1',
            state: 'latest_scan',
            event_id: null,
            event_type_id: null,
            bucket: '2026-01-02T00:00:00Z',
            actual_count: 0,
            expected_count: 15,
            stddev: 0,
            z_score: -15,
            direction: 'drop',
          },
          {
            scan_config_id: 'scan-1',
            scope_type: 'event_type',
            scope_ref: 'type-1',
            state: 'recent',
            event_id: null,
            event_type_id: 'type-1',
            bucket: '2026-01-02T00:00:00Z',
            actual_count: 0,
            expected_count: 15,
            stddev: 0,
            z_score: -15,
            direction: 'drop',
          },
          {
            scan_config_id: 'scan-1',
            scope_type: 'event',
            scope_ref: 'event-1',
            state: 'recent',
            event_id: 'event-1',
            event_type_id: null,
            bucket: '2026-01-02T00:00:00Z',
            actual_count: 0,
            expected_count: 10,
            stddev: 0,
            z_score: -10,
            direction: 'drop',
          },
        ])
      }
      if (url.includes('/api/v1/projects/demo/events')) {
        return mockJsonResponse({
          items: [makeEvent()],
          total: 1,
        })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const { container } = renderEventsPage()

    expect(await screen.findByText('Homepage View')).toBeInTheDocument()
    const eventHeader = screen.getByRole('columnheader', { name: 'Event' })
    const typeHeader = screen.getByRole('columnheader', { name: 'Type' })
    const metricsHeader = screen.getByRole('columnheader', { name: '48h' })
    expect(typeHeader.compareDocumentPosition(metricsHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(eventHeader).toBeInTheDocument()
    // The trailing sticky "Actions" column and its hover cluster were removed;
    // reordering is now drag-handle only.
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument()
    expect(screen.getByText('48h')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '7d' })).toBeInTheDocument()
    expect(screen.getByText('Hours')).toBeInTheDocument()
    const metricsButton = await screen.findByRole('button', { name: '1k' })
    expect(metricsButton).toBeInTheDocument()
    // The row exposes no inline action buttons — Edit/Metrics/Archive/Delete and
    // move/status now live on the event detail page, not on the row.
    expect(screen.queryByRole('button', { name: 'Edit event' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument()
    expect(container.querySelector('a[href="/p/demo/monitoring/project-total/scan-1"]')).toBeInTheDocument()
    expect(container.querySelector('a[href="/p/demo/monitoring/event-type/type-1"]')).not.toBeInTheDocument()
    expect(container.querySelector('a[href="/p/demo/monitoring/event/event-1"]')).toBeInTheDocument()
    expect(screen.getAllByLabelText('Open recent anomaly')).toHaveLength(1)

    fireEvent.mouseOver(metricsButton)
    fireEvent.focus(metricsButton)
    expect((await screen.findAllByText('Last 48 hours')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('1k events').length).toBeGreaterThan(0)

    // The hover action cluster was removed entirely — no move up/down buttons
    // and no per-row status select.
    expect(screen.queryByRole('button', { name: 'Move event up' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Move event down' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Set event status' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'View metrics' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Archive event' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete event' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Show chart'))
    expect(await screen.findByText('View signal')).toBeInTheDocument()
  }, 10_000)

  it('renders active event-type anomaly link for sidebar-selected view', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

      if (url.endsWith('/api/v1/projects/demo/event-types')) {
        return mockJsonResponse([
          {
            id: 'type-1',
            project_id: 'project-1',
            name: 'page',
            display_name: 'Page',
            description: '',
            color: '#ec4899',
            order: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            field_definitions: [],
          },
        ])
      }
      if (url.endsWith('/api/v1/projects/demo/meta-fields')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/variables')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/events/tags')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/events') && url.includes('status=in_review') && url.includes('limit=1')) {
        return mockJsonResponse({ items: [], total: 0 })
      }
      if (url.includes('/api/v1/projects/demo/events-metrics')) {
        return mockJsonResponse({
          scope: 'events_total',
          scan_config_id: null,
          event_id: null,
          event_type_id: null,
          interval: '1h',
          latest_signal: null,
          data: [],
        })
      }
      if (url.endsWith('/api/v1/projects/demo/events/window-metrics') && init?.method === 'POST') {
        return mockJsonResponse([])
      }
      if (url.endsWith('/api/v1/projects/demo/anomalies/signals')) {
        return mockJsonResponse([
          {
            scan_config_id: 'scan-1',
            scope_type: 'project_total',
            scope_ref: 'scan-1',
            state: 'latest_scan',
            event_id: null,
            event_type_id: null,
            bucket: '2026-01-02T00:00:00Z',
            actual_count: 0,
            expected_count: 20,
            stddev: 0,
            z_score: -20,
            direction: 'drop',
          },
          {
            scan_config_id: 'scan-1',
            scope_type: 'event_type',
            scope_ref: 'type-1',
            state: 'recent',
            event_id: null,
            event_type_id: 'type-1',
            bucket: '2026-01-02T00:00:00Z',
            actual_count: 0,
            expected_count: 12,
            stddev: 0,
            z_score: -12,
            direction: 'drop',
          },
        ])
      }
      if (url.endsWith('/api/v1/projects/demo/anomalies/signals/query') && init?.method === 'POST') {
        return mockJsonResponse([])
      }
      if (url.includes('/api/v1/projects/demo/events')) {
        return mockJsonResponse({
          items: [makeEvent({ id: 'active-event-1', name: 'Active Signup', event_type: { id: 'type-1', name: 'page', display_name: 'Page', color: '#ec4899' } })],
          total: 1,
        })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const { container } = renderEventsPage(['/p/demo/events/page'])

    expect(await screen.findByText('Active Signup')).toBeInTheDocument()
    expect(screen.getByText('Page Dynamics')).toBeInTheDocument()
    await waitFor(() => {
      expect(container.querySelector('a[href="/p/demo/monitoring/event-type/type-1"]')).toBeInTheDocument()
    })
    expect(container.querySelector('a[href="/p/demo/monitoring/project-total/scan-1"]')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument()
  })

  it('supports selecting multiple events and bulk deleting them', async () => {
    const bulkDeleteBodies: unknown[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

      if (url.endsWith('/api/v1/projects/demo/event-types')) {
        return mockJsonResponse([
          {
            id: 'type-1',
            project_id: 'project-1',
            name: 'page',
            display_name: 'Page',
            description: '',
            color: '#0ea5e9',
            order: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            field_definitions: [],
          },
        ])
      }
      if (url.endsWith('/api/v1/projects/demo/meta-fields')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/variables')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/events/tags')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/events') && url.includes('status=in_review') && url.includes('limit=1')) return mockJsonResponse({ items: [], total: 0 })
      if (url.includes('/api/v1/projects/demo/events-metrics')) {
        return mockJsonResponse({
          scope: 'events_total',
          scan_config_id: null,
          event_id: null,
          event_type_id: null,
          interval: '1h',
          latest_signal: null,
          data: [],
        })
      }
      if (url.endsWith('/api/v1/projects/demo/events/window-metrics') && init?.method === 'POST') {
        return mockJsonResponse([])
      }
      if (url.includes('/api/v1/projects/demo/anomalies/signals')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/events/bulk-delete') && init?.method === 'POST') {
        bulkDeleteBodies.push(JSON.parse(String(init.body)))
        return new Response(null, { status: 204 })
      }
      if (url.includes('/api/v1/projects/demo/events')) {
        return mockJsonResponse({
          items: [
            makeEvent({ id: 'event-1', name: 'Homepage View', status: 'live' }),
            makeEvent({ id: 'event-2', name: 'Settings View', order: 1, status: 'draft' }),
          ],
          total: 2,
        })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderEventsPage()

    expect(await screen.findByText('Homepage View')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Select Homepage View'))
    fireEvent.click(screen.getByLabelText('Select Settings View'))

    expect(
      screen.getByText((_, node) => node?.textContent === '2 selected' && node.tagName === 'SPAN'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(bulkDeleteBodies).toContainEqual({ event_ids: ['event-1', 'event-2'] })
    })
  })

  it('supports bulk status transitions for selected events', async () => {
    const bulkUpdateBodies: unknown[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

      if (url.endsWith('/api/v1/projects/demo/event-types')) {
        return mockJsonResponse([
          {
            id: 'type-1',
            project_id: 'project-1',
            name: 'page',
            display_name: 'Page',
            description: '',
            color: '#0ea5e9',
            order: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            field_definitions: [],
          },
        ])
      }
      if (url.endsWith('/api/v1/projects/demo/meta-fields')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/variables')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/events/tags')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/events') && url.includes('status=in_review') && url.includes('limit=1')) return mockJsonResponse({ items: [], total: 0 })
      if (url.includes('/api/v1/projects/demo/events-metrics')) {
        return mockJsonResponse({
          scope: 'events_total',
          scan_config_id: null,
          event_id: null,
          event_type_id: null,
          interval: '1h',
          latest_signal: null,
          data: [],
        })
      }
      if (url.endsWith('/api/v1/projects/demo/events/window-metrics') && init?.method === 'POST') {
        return mockJsonResponse([])
      }
      if (url.includes('/api/v1/projects/demo/anomalies/signals')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/events/bulk-update') && init?.method === 'POST') {
        bulkUpdateBodies.push(JSON.parse(String(init.body)))
        return new Response(null, { status: 204 })
      }
      if (url.includes('/api/v1/projects/demo/events')) {
        return mockJsonResponse({
          items: [
            makeEvent({ id: 'event-1', name: 'Homepage View', status: 'live' }),
            makeEvent({ id: 'event-2', name: 'Settings View', order: 1, status: 'draft' }),
          ],
          total: 2,
        })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderEventsPage()

    expect(await screen.findByText('Homepage View')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Select Homepage View'))
    fireEvent.click(screen.getByLabelText('Select Settings View'))

    // BulkActionBar shows a "Set status…" select
    expect(screen.getByRole('combobox', { name: 'Set status' })).toBeInTheDocument()
  })

  it('creates an event with selected event-level metric breakdowns', async () => {
    const eventCreateBodies: unknown[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

      if (url.endsWith('/api/v1/projects/demo/event-types')) {
        return mockJsonResponse([
          {
            id: 'type-1',
            project_id: 'project-1',
            name: 'page',
            display_name: 'Page',
            description: '',
            color: '#0ea5e9',
            order: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            field_definitions: [
              {
                id: 'field-country',
                event_type_id: 'type-1',
                name: 'country',
                display_name: 'Country',
                field_type: 'string',
                is_required: false,
                enum_options: null,
                description: '',
                order: 0,
                sensitivity: 'none',
              },
              {
                id: 'field-payload',
                event_type_id: 'type-1',
                name: 'payload',
                display_name: 'Payload',
                field_type: 'json',
                is_required: false,
                enum_options: null,
                description: '',
                order: 1,
                sensitivity: 'none',
              },
            ],
          },
        ])
      }
      if (url.endsWith('/api/v1/projects/demo/meta-fields')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/variables')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/events/tags')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/events') && url.includes('status=in_review') && url.includes('limit=1')) return mockJsonResponse({ items: [], total: 0 })
      if (url.includes('/api/v1/projects/demo/events-metrics')) {
        return mockJsonResponse({
          scope: 'events_total',
          scan_config_id: null,
          event_id: null,
          event_type_id: null,
          interval: '1h',
          latest_signal: null,
          data: [],
        })
      }
      if (url.endsWith('/api/v1/projects/demo/events/window-metrics') && init?.method === 'POST') {
        return mockJsonResponse([])
      }
      if (url.includes('/api/v1/projects/demo/anomalies/signals')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/events') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        eventCreateBodies.push(body)
        return mockJsonResponse({
          ...makeEvent({ name: body.name, status: body.status ?? 'draft', metric_breakdown_columns: body.metric_breakdown_columns }),
          event_type_id: body.event_type_id,
        })
      }
      if (url.includes('/api/v1/projects/demo/events')) {
        return mockJsonResponse({ items: [], total: 0 })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderEventsPage()

    // "New event" navigates to the page-based editor (no Sheet/dialog).
    fireEvent.click(await screen.findByRole('button', { name: 'New Event' }))
    expect(await screen.findByRole('heading', { name: 'New event' })).toBeInTheDocument()

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'type-1' } })
    fireEvent.change(screen.getByPlaceholderText('e.g. checkout_completed'), {
      target: { value: 'Homepage View' },
    })
    // Metric breakdowns are fixed toggle chips; click country then platform.
    fireEvent.click(screen.getByRole('button', { name: 'country' }))
    fireEvent.click(screen.getByRole('button', { name: 'platform' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create event' }))

    await waitFor(() => {
      expect(eventCreateBodies).toContainEqual(
        expect.objectContaining({
          event_type_id: 'type-1',
          name: 'Homepage View',
          description: '',
          status: 'draft',
          metric_breakdown_columns: ['country', 'platform'],
          tags: [],
          field_values: [],
          meta_values: [],
        }),
      )
    })
  })
})
