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
