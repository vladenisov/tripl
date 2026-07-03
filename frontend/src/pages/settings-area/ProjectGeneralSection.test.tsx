import { fireEvent, render, screen, within } from '@testing-library/react'
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

function authValue(role: 'owner' | 'editor' | 'viewer'): AuthContextValue {
  return {
    user: {
      id: `${role}-1`,
      email: `${role}@example.com`,
      name: role,
      role,
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

function ownerAuthValue(): AuthContextValue {
  return authValue('owner')
}

function renderSection(auth: AuthContextValue = ownerAuthValue()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
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

    // Defaults selects (branch / environment / timezone) must be disabled. The
    // owner-only danger-zone period selects are separate, enabled comboboxes, so
    // assert on the disabled subset.
    const disabledSelects = screen
      .getAllByRole('combobox')
      .filter((select) => (select as HTMLSelectElement).disabled)
    expect(disabledSelects).toHaveLength(3)
    disabledSelects.forEach((select) => expect(select).toBeDisabled())

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

  it('shows both reset danger actions to owners', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo')) return jsonResponse(PROJECT)
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderSection()

    expect(await screen.findByRole('button', { name: 'Reset anomalies' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset drifts' })).toBeInTheDocument()
  })

  it('hides the reset danger actions from non-owners', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo')) return jsonResponse(PROJECT)
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderSection(authValue('editor'))

    // Wait for the project to load (Delete row always renders), then confirm the
    // owner-only reset actions are absent.
    await screen.findByRole('button', { name: /Delete project/ })
    expect(screen.queryByRole('button', { name: 'Reset anomalies' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset drifts' })).not.toBeInTheDocument()
  })

  it('resets anomalies with the chosen period after confirmation', async () => {
    let resetBody: { before?: string | null; after?: string | null } | null = null
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo') && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(PROJECT)
      }
      if (
        url.endsWith('/api/v1/projects/demo/danger/reset-anomalies') &&
        init?.method === 'POST'
      ) {
        resetBody = JSON.parse(String(init?.body))
        return jsonResponse({ metric_anomalies: 5, metric_breakdown_anomalies: 2 })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderSection()

    // Pick "Older than 7 days" (not the 30-day default) to prove the period ships.
    fireEvent.change(await screen.findByLabelText('Reset anomalies period'), {
      target: { value: '7d' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reset anomalies' }))

    // Confirm in the irreversible-action dialog.
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset anomalies' }))

    expect(
      await screen.findByText('Cleared 5 anomalies and 2 breakdown anomalies.'),
    ).toBeInTheDocument()

    expect(resetBody).not.toBeNull()
    const body = resetBody as unknown as { before: string; after: string | null }
    expect(body.after).toBeNull()
    // The cutoff must be ~7 days ago (the chosen window), not the 30-day default.
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
    expect(Math.abs(Date.now() - Date.parse(body.before) - sevenDaysMs)).toBeLessThan(60_000)
  })
})
