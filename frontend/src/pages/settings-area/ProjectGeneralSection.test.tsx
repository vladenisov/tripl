import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import ProjectGeneralSection from './ProjectGeneralSection'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const PROJECT = {
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
    monitoring_signal_count: 0,
    latest_scan_job: null,
    latest_signal: null,
  },
}

function ownerAuthValue(): AuthContextValue {
  return {
    user: {
      id: 'owner-1',
      email: 'owner@example.com',
      name: 'Owner',
      role: 'owner',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    status: 'authenticated',
    error: null,
    isLoggingOut: false,
    logout: async () => {},
    refresh: () => {},
  }
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={ownerAuthValue()}>
        <MemoryRouter initialEntries={['/settings/project/general']}>
          <ProjectGeneralSection slug="demo" />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ProjectGeneralSection', () => {
  it('rebuilds the search index', async () => {
    const calls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/api/v1/projects/demo')) return jsonResponse(PROJECT)
      if (url.endsWith('/api/v1/projects/demo/search/reindex') && init?.method === 'POST') {
        return jsonResponse({ documents_indexed: 42, embeddings_scheduled: false })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderSection()

    fireEvent.click(await screen.findByRole('button', { name: /Rebuild index/i }))

    expect(await screen.findByText('Indexed 42 documents.')).toBeInTheDocument()
    expect(calls).toContain('POST /api/v1/projects/demo/search/reindex')
  })

  it('renders preview-only accent + defaults as disabled "Coming soon" controls', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo')) return jsonResponse(PROJECT)
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderSection()

    // Accent swatches must be inert (disabled), not interactive-looking no-ops.
    const swatches = await screen.findAllByRole('button', { name: /Accent color:/ })
    expect(swatches.length).toBeGreaterThan(0)
    swatches.forEach((swatch) => expect(swatch).toBeDisabled())

    // Defaults selects (branch / environment / timezone) must be disabled.
    const selects = screen.getAllByRole('combobox')
    expect(selects).toHaveLength(3)
    selects.forEach((select) => expect(select).toBeDisabled())

    // Every inert section carries an explicit "Coming soon" note.
    expect(screen.getAllByText(/Coming soon/i).length).toBeGreaterThan(0)
  })

  it('exposes a Delete project danger action for owners', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo')) return jsonResponse(PROJECT)
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderSection()

    expect(await screen.findByRole('button', { name: /Delete project/ })).toBeInTheDocument()
  })
})
