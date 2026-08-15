import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from './auth-context'
import { CommandPaletteProvider } from './command-palette'
import {
  COMMAND_PALETTE_TRIGGER_ATTR,
  useCommandPalette,
} from './command-palette-context'

function mockJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const authValue: AuthContextValue = {
  user: {
    id: 'user-1',
    email: 'owner@example.com',
    name: 'Owner',
    role: 'owner',
    created_at: '2026-04-18T10:00:00Z',
    updated_at: '2026-04-18T10:00:00Z',
  },
  status: 'authenticated',
  error: null,
  isLoggingOut: false,
  logout: async () => {},
  refresh: () => {},
}

function PaletteOpener() {
  const palette = useCommandPalette()
  return (
    <button type="button" onClick={() => palette.setOpen(true)} data-testid="open-palette">
      open
    </button>
  )
}

/** Stands in for the top-bar search button that the palette falls back to. */
function TopBarTrigger() {
  const palette = useCommandPalette()
  return (
    <button
      type="button"
      {...{ [COMMAND_PALETTE_TRIGGER_ATTR]: '' }}
      onClick={() => palette.setOpen(true)}
      data-testid="topbar-trigger"
    >
      search
    </button>
  )
}

function LocationBeacon() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

function renderHarness(initialEntry = '/p/demo/events') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route
              path="/p/:slug/events"
              element={
                <CommandPaletteProvider>
                  <LocationBeacon />
                  <PaletteOpener />
                  <TopBarTrigger />
                </CommandPaletteProvider>
              }
            />
            <Route
              path="/p/:slug/settings"
              element={
                <CommandPaletteProvider>
                  <LocationBeacon />
                </CommandPaletteProvider>
              }
            />
            <Route path="/p/:slug/events/detail/:eventId" element={<LocationBeacon />} />
            <Route path="/p/:slug/settings/:tab" element={<LocationBeacon />} />
            <Route path="/p/:slug/monitoring" element={<LocationBeacon />} />
            <Route path="/p/:slug/alerting" element={<LocationBeacon />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CommandPalette', () => {
  it('opens via setOpen, lists projects, and navigates on select', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects')) {
        return mockJsonResponse([
          {
            id: 'project-1',
            name: 'Demo',
            slug: 'demo',
            description: '',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            summary: {
              event_type_count: 0,
              event_count: 0,
              active_event_count: 0,
              implemented_event_count: 0,
              review_pending_event_count: 0,
              archived_event_count: 0,
              variable_count: 0,
              scan_count: 0,
              alert_destination_count: 0,
              alert_rule_count: 0,
              monitoring_signal_count: 0,
              latest_scan_job: null,
              latest_signal: null,
            },
          },
        ])
      }
      if (url.endsWith('/api/v1/projects/demo/event-types')) {
        return mockJsonResponse([])
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderHarness('/p/demo/events')

    fireEvent.click(screen.getByTestId('open-palette'))

    expect(await screen.findByPlaceholderText(/Search projects/i)).toBeInTheDocument()
    expect(await screen.findByText('Demo')).toBeInTheDocument()
    expect(screen.getByText('Event type settings')).toBeInTheDocument()
    expect(screen.getByText('Meta field settings')).toBeInTheDocument()
    expect(screen.getByText('Relation settings')).toBeInTheDocument()
    expect(screen.getByText('Variable settings')).toBeInTheDocument()
    expect(screen.getByText('Monitoring settings')).toBeInTheDocument()
    expect(screen.getByText('Alerting settings')).toBeInTheDocument()
    // Not "Scan settings": scans are an operational surface with its own
    // top-level route, not a settings tab.
    expect(screen.getByText('Scans')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Project settings'))

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/p/demo/settings')
    })
  })

  it('navigates to project monitoring from the command palette', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects')) {
        return mockJsonResponse([
          {
            id: 'project-1',
            name: 'Demo',
            slug: 'demo',
            description: '',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            summary: {
              event_type_count: 0,
              event_count: 0,
              active_event_count: 0,
              implemented_event_count: 0,
              review_pending_event_count: 0,
              archived_event_count: 0,
              variable_count: 0,
              scan_count: 0,
              alert_destination_count: 0,
              alert_rule_count: 0,
              monitoring_signal_count: 0,
              latest_scan_job: null,
              latest_signal: null,
            },
          },
        ])
      }
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderHarness('/p/demo/events')

    fireEvent.click(screen.getByTestId('open-palette'))
    fireEvent.click(await screen.findByText('Monitoring settings'))

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/p/demo/settings/monitoring')
    })
  })

  it('labels navigation with the same terms as the sidebar and settings nav', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderHarness('/p/demo/events')

    fireEvent.click(screen.getByTestId('open-palette'))

    // Canonical terms shared with the settings nav.
    expect(await screen.findByText('Members')).toBeInTheDocument()
    expect(screen.getByText('Runtime')).toBeInTheDocument()

    // The old, divergent palette-only labels are gone.
    expect(screen.queryByText('Users')).toBeNull()
    expect(screen.queryByText('Service settings')).toBeNull()
  })

  it('toggles via ⌘K keyboard shortcut', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderHarness('/p/demo/events')

    expect(screen.queryByPlaceholderText(/Search projects/i)).toBeNull()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })

    expect(await screen.findByPlaceholderText(/Search projects/i)).toBeInTheDocument()
  })

  it('toggles via Ctrl+K on non-Mac platforms', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderHarness('/p/demo/events')

    expect(screen.queryByPlaceholderText(/Search projects/i)).toBeNull()

    // The keydown handler is intentionally permissive (Meta OR Ctrl) so the
    // shortcut works on Linux/Windows where there is no Meta key.
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })

    expect(await screen.findByPlaceholderText(/Search projects/i)).toBeInTheDocument()
  })

  it('shows typed knowledge search results and navigates to their route', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects')) {
        return mockJsonResponse([
          {
            id: 'project-1',
            name: 'Demo',
            slug: 'demo',
            description: '',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            summary: {
              event_type_count: 0,
              event_count: 0,
              active_event_count: 0,
              implemented_event_count: 0,
              review_pending_event_count: 0,
              archived_event_count: 0,
              variable_count: 0,
              scan_count: 0,
              alert_destination_count: 0,
              alert_rule_count: 0,
              monitoring_signal_count: 0,
              latest_scan_job: null,
              latest_signal: null,
            },
          },
        ])
      }
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/search?')) {
        return mockJsonResponse({
          items: [
            {
              id: 'doc-1',
              entity_type: 'event',
              entity_id: 'event-1',
              parent_event_id: 'event-1',
              title: 'Checkout Completed',
              subtitle: 'Checkout',
              snippet: 'завершение покупки',
              route_path: '/p/demo/events/detail/event-1',
              score: 8,
              highlights: ['завершение покупки'],
              semantic_used: false,
            },
          ],
          total: 1,
          semantic_used: false,
        })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderHarness('/p/demo/events')

    fireEvent.click(screen.getByTestId('open-palette'))
    fireEvent.change(await screen.findByPlaceholderText(/Search projects/i), {
      target: { value: 'покупки' },
    })

    fireEvent.click(await screen.findByText('Checkout Completed'))

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/p/demo/events/detail/event-1')
    })
  })

  it('marks only semantically matched results with a semantic chip (tripl-odrj.5)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects')) {
        return mockJsonResponse([
          {
            id: 'project-1',
            name: 'Demo',
            slug: 'demo',
            description: '',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            summary: {
              event_type_count: 0,
              event_count: 0,
              active_event_count: 0,
              implemented_event_count: 0,
              review_pending_event_count: 0,
              archived_event_count: 0,
              variable_count: 0,
              scan_count: 0,
              alert_destination_count: 0,
              alert_rule_count: 0,
              monitoring_signal_count: 0,
              latest_scan_job: null,
              latest_signal: null,
            },
          },
        ])
      }
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/search?')) {
        return mockJsonResponse({
          items: [
            {
              id: 'doc-sem',
              entity_type: 'event',
              entity_id: 'event-1',
              parent_event_id: 'event-1',
              title: 'Refund Issued',
              subtitle: 'Billing',
              snippet: 'customer got their money back',
              route_path: '/p/demo/events/detail/event-1',
              score: 8,
              highlights: [],
              semantic_used: true,
            },
            {
              id: 'doc-lex',
              entity_type: 'event',
              entity_id: 'event-2',
              parent_event_id: 'event-2',
              title: 'Checkout Completed',
              subtitle: 'Checkout',
              snippet: 'money back guarantee shown',
              route_path: '/p/demo/events/detail/event-2',
              score: 6,
              highlights: [],
              semantic_used: false,
            },
          ],
          total: 2,
          semantic_used: true,
        })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderHarness('/p/demo/events')

    fireEvent.click(screen.getByTestId('open-palette'))
    fireEvent.change(await screen.findByPlaceholderText(/Search projects/i), {
      target: { value: 'money back' },
    })

    expect(await screen.findByText('Refund Issued')).toBeInTheDocument()
    expect(screen.getByText('Checkout Completed')).toBeInTheDocument()
    // Exactly the semantic_used row carries the chip — the lexical one does not.
    expect(screen.getAllByText('semantic')).toHaveLength(1)
  })
})

/**
 * The palette used to hand every rendered row to cmdk's own fuzzy scorer, which
 * sorts AND re-appends the DOM nodes. These cover what turning that off has to
 * preserve, the one thing it exists to preserve, and the two list-empty states
 * it made reachable for the first time (tripl-k6gt).
 */
describe('CommandPalette ranking and filtering (tripl-k6gt)', () => {
  function projectFixture(project: { id: string; name: string; slug: string }) {
    return {
      ...project,
      description: '',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      summary: {
        event_type_count: 0,
        event_count: 0,
        active_event_count: 0,
        implemented_event_count: 0,
        review_pending_event_count: 0,
        archived_event_count: 0,
        variable_count: 0,
        scan_count: 0,
        alert_destination_count: 0,
        alert_rule_count: 0,
        monitoring_signal_count: 0,
        latest_scan_job: null,
        latest_signal: null,
      },
    }
  }

  /**
   * One row of a search response. `entityType` and `score` are parameters and
   * not constants on purpose, because both were constants once and both hid a
   * regression: with every fixture typed `event` only one group ever rendered,
   * so the first-appearance group ordering in `groupSearchResults` was untested
   * and a `.sort()` over the group list passed; with every fixture at `score: 8`
   * `Array#sort` was stable, so re-sorting the rows by score changed no DOM and
   * that passed too.
   */
  function searchDocument(fields: {
    id: string
    entityType: string
    title: string
    subtitle: string
    score: number
  }) {
    return {
      id: fields.id,
      entity_type: fields.entityType,
      entity_id: fields.id,
      parent_event_id: fields.id,
      title: fields.title,
      subtitle: fields.subtitle,
      snippet: '',
      route_path: `/p/demo/events/detail/${fields.id}`,
      score: fields.score,
      highlights: [],
      semantic_used: false,
    }
  }

  /** Mocks projects + event types for one project, and the search route with `search`. */
  function mockPalette(
    project: { id: string; name: string; slug: string },
    search: (url: string) => Promise<Response>,
  ) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects')) {
        return mockJsonResponse([projectFixture(project)])
      }
      if (url.endsWith(`/api/v1/projects/${project.slug}/event-types`)) {
        return mockJsonResponse([])
      }
      if (url.includes(`/api/v1/projects/${project.slug}/search?`)) return search(url)
      throw new Error(`Unhandled fetch: ${url}`)
    })
  }

  const emptySearch = async () =>
    mockJsonResponse({ items: [], total: 0, semantic_used: false })

  it('renders knowledge results in the order the API returned them', async () => {
    // Three rows chosen so that every plausible client-side reordering is
    // VISIBLE here, not just absent:
    //
    // * Two entity types, with rank 0 held by the non-`event` one. Ordering the
    //   headings by anything but arrival — say `SEARCH_TYPE_META`'s key order,
    //   where `event` comes first — moves the variable group below the events.
    // * Scores that CONTRADICT the server's order: the rank-0 row scores lowest
    //   and the last row scores highest. Any re-sort by `score`, whether over
    //   the whole list or within one bucket, inverts a pair the assertions pin.
    //   (The real service ships descending score; disagreeing here is the whole
    //   point — the palette must render what it was handed, not recompute it.)
    // * The two event rows are the pathological pair for cmdk's own scorer: it
    //   anchors on the start of the string, so it ranked the short literal title
    //   first (0.98990) and the stem-matched body hit second (0.89100) — the
    //   exact inversion the search service was written to avoid (#114).
    mockPalette({ id: 'project-1', name: 'Demo', slug: 'demo' }, async () =>
      mockJsonResponse({
        items: [
          searchDocument({
            id: 'doc-ranked-0',
            entityType: 'variable',
            title: 'Архивный порог',
            subtitle: 'archive_threshold',
            score: 3,
          }),
          searchDocument({
            id: 'doc-ranked-1',
            entityType: 'event',
            title: 'Пользователь открыл архив',
            subtitle: 'Архив',
            score: 4,
          }),
          searchDocument({
            id: 'doc-ranked-2',
            entityType: 'event',
            title: 'Архивы экрана',
            subtitle: 'Экран',
            score: 9,
          }),
        ],
        total: 3,
        semantic_used: false,
      }),
    )

    renderHarness('/p/demo/events')

    fireEvent.click(screen.getByTestId('open-palette'))
    fireEvent.change(await screen.findByPlaceholderText(/Search projects/i), {
      target: { value: 'архивы' },
    })

    await screen.findByText('Пользователь открыл архив')

    // Read the rendered rows, not the response: cmdk reorders by appendChild, so
    // only DOM position can tell whether the server's ranking survived. The
    // query is Cyrillic and every static label is not, so these options are the
    // knowledge rows and nothing else.
    const rows = screen.getAllByRole('option').map(row => row.textContent ?? '')
    const positionOf = (title: string) => rows.findIndex(text => text.includes(title))
    const weakestFirst = positionOf('Архивный порог')
    const stemMatched = positionOf('Пользователь открыл архив')
    const literalMatch = positionOf('Архивы экрана')

    expect(weakestFirst).toBe(0)
    // Group order: the variable arrived first, so its heading comes first.
    expect(stemMatched).toBeGreaterThan(weakestFirst)
    // Row order inside the event group: server order, not score order.
    expect(literalMatch).toBeGreaterThan(stemMatched)
  })

  it('narrows the static groups as you type', async () => {
    mockPalette({ id: 'project-1', name: 'Demo', slug: 'demo' }, emptySearch)

    renderHarness('/p/demo/events')

    fireEvent.click(screen.getByTestId('open-palette'))
    expect(await screen.findByText('Overview')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText(/Search projects/i), {
      target: { value: 'monitoring' },
    })

    await waitFor(() => {
      expect(screen.queryByText('Overview')).toBeNull()
    })
    expect(screen.getByText('Monitoring settings')).toBeInTheDocument()
    expect(screen.queryByText('Data sources')).toBeNull()
  })

  it('drops a group heading when nothing in that group matches', async () => {
    mockPalette({ id: 'project-1', name: 'Demo', slug: 'demo' }, emptySearch)

    renderHarness('/p/demo/events')

    fireEvent.click(screen.getByTestId('open-palette'))
    expect(await screen.findByText('Projects')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText(/Search projects/i), {
      target: { value: 'monitoring' },
    })

    // cmdk hides nothing once its own filter is off, so an empty group keeps its
    // heading on screen unless the group itself declines to render.
    await waitFor(() => {
      expect(screen.queryByText('Demo')).toBeNull()
    })
    expect(screen.queryByText('Projects')).toBeNull()
  })

  it('keeps a project findable by its slug', async () => {
    // Name and slug share no substring, so only a haystack holding both can find
    // this row — the term the deleted `keywords={[slug, name]}` used to carry.
    mockPalette(
      { id: 'project-1', name: 'Acme Analytics', slug: 'checkout-web' },
      emptySearch,
    )

    renderHarness('/p/checkout-web/events')

    fireEvent.click(screen.getByTestId('open-palette'))
    expect(await screen.findByText('Acme Analytics')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText(/Search projects/i), {
      target: { value: 'checkout-web' },
    })

    await waitFor(() => {
      expect(screen.queryByText('Overview')).toBeNull()
    })
    expect(screen.getByText('Acme Analytics')).toBeInTheDocument()
  })

  it('does not claim "No matches." while the knowledge search is in flight', async () => {
    mockPalette(
      { id: 'project-1', name: 'Demo', slug: 'demo' },
      () => new Promise<Response>(() => {}),
    )

    renderHarness('/p/demo/events')

    fireEvent.click(screen.getByTestId('open-palette'))
    fireEvent.change(await screen.findByPlaceholderText(/Search projects/i), {
      // Matches no static label or route, so every static group is gone and the
      // registered-item count is 0 — the state cmdk reports as "empty".
      target: { value: 'zzzqqq' },
    })

    expect(await screen.findByText('Searching.')).toBeInTheDocument()
    expect(screen.queryByText('No matches.')).toBeNull()
  })

  it('claims nothing about the knowledge base during the debounce window', async () => {
    mockPalette({ id: 'project-1', name: 'Demo', slug: 'demo' }, emptySearch)

    renderHarness('/p/demo/events')

    fireEvent.click(screen.getByTestId('open-palette'))
    // Wait for the project list first: without a loaded project there is no slug
    // to search, and the palette would be quiet for a reason that has nothing to
    // do with the debounce.
    expect(await screen.findByText('Demo')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText(/Search projects/i), {
      target: { value: 'zzzqqq' },
    })

    // Asserted synchronously, on purpose: this is the SEARCH_DEBOUNCE_MS window
    // before the request is even sent. The static rows narrow against the LIVE
    // query, so they are already gone; anything the list says here it says about
    // a search that has not run yet. A state machine keyed on the debounced
    // query alone reads this moment as "answered, and the answer is nothing".
    expect(screen.getByText('Searching.')).toBeInTheDocument()
    expect(screen.queryByText('No knowledge matches.')).toBeNull()
    expect(screen.queryByText('No matches.')).toBeNull()
  })

  it('shows "No matches." when a query below the search floor matches nothing', async () => {
    mockPalette({ id: 'project-1', name: 'Demo', slug: 'demo' }, emptySearch)

    renderHarness('/p/demo/events')

    fireEvent.click(screen.getByTestId('open-palette'))
    expect(await screen.findByText('Overview')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText(/Search projects/i), {
      // One character, so knowledge search never starts (2-char floor), and one
      // that appears in no static label or route — the only shape of query for
      // which the palette has nothing whatsoever to show.
      target: { value: 'z' },
    })

    // The palette's only "we found you nothing" affordance. Asserted PRESENT,
    // because every other assertion about it in this file is an absence — so
    // deleting the block outright used to keep the suite green.
    expect(await screen.findByText('No matches.')).toBeInTheDocument()
    expect(screen.queryByText('Overview')).toBeNull()
    expect(screen.queryByText('Sign out')).toBeNull()
  })

  it('shows one empty state, not two, when the knowledge search comes back empty', async () => {
    mockPalette({ id: 'project-1', name: 'Demo', slug: 'demo' }, emptySearch)

    renderHarness('/p/demo/events')

    fireEvent.click(screen.getByTestId('open-palette'))
    fireEvent.change(await screen.findByPlaceholderText(/Search projects/i), {
      // Matches no static label or route, so every static group is gone: the
      // configuration where the list-wide empty line and the knowledge
      // section's own empty line both used to render, one above the other.
      target: { value: 'zzzqqq' },
    })

    expect(await screen.findByText('No knowledge matches.')).toBeInTheDocument()
    expect(screen.queryByText('No matches.')).toBeNull()
  })

  it('reports a failed knowledge search as a failure, not as an empty knowledge base', async () => {
    mockPalette({ id: 'project-1', name: 'Demo', slug: 'demo' }, async () =>
      new Response(JSON.stringify({ detail: 'search backend down' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    renderHarness('/p/demo/events')

    fireEvent.click(screen.getByTestId('open-palette'))
    fireEvent.change(await screen.findByPlaceholderText(/Search projects/i), {
      target: { value: 'zzzqqq' },
    })

    expect(await screen.findByText(/Knowledge search failed/)).toBeInTheDocument()
    // A 500 and an empty index both leave `data?.items ?? []` at length 0. The
    // palette must not turn the first into a claim about the user's data.
    expect(screen.queryByText('No knowledge matches.')).toBeNull()
    expect(screen.queryByText('No matches.')).toBeNull()
  })
})

describe('CommandPalette focus restore', () => {
  function mockEmptyProject() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
  }

  it('hands focus back to the button that opened it', async () => {
    mockEmptyProject()
    renderHarness('/p/demo/events')

    const opener = screen.getByTestId('open-palette')
    opener.focus()
    fireEvent.click(opener)
    await screen.findByPlaceholderText(/Search projects/i)

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    await waitFor(() => {
      expect(document.activeElement).toBe(opener)
    })
  })

  it('falls back to the top-bar trigger when Ctrl+K opened it from nowhere', async () => {
    mockEmptyProject()
    renderHarness('/p/demo/events')

    // Nothing focused: exactly the state a global Ctrl+K on a fresh page leaves,
    // where Radix would restore focus to <body> (tripl-jfm3.68).
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByPlaceholderText(/Search projects/i)

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('topbar-trigger'))
    })
    expect(document.activeElement).not.toBe(document.body)
  })
})
